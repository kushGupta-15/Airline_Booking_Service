const { BookingRepository } = require('../repository/index.js');
const axios = require('axios');
const CircuitBreaker = require('opossum');
const { FLIGHT_SERVICE_PATH, REMINDER_BINDING_KEY } = require('../config/serverConfig.js');
const { ServiceError } = require('../utils/errors/index.js');
const { createChannel, publishMessage } = require('../utils/messageQueue.js');

const breakerTimeout = parseInt(process.env.CIRCUIT_BREAKER_TIMEOUT || '10000', 10);
const breakerOptions = {
    timeout: breakerTimeout, // Allow up to 10s for downstream service warm-up/cold starts
    errorThresholdPercentage: 50, // Open breaker if >= 50% requests fail
    resetTimeout: 10000 // Try half-open test after 10 seconds
};

class BookingService {
    constructor() {
        this.BookingRepository = new BookingRepository();

        // Circuit breaker for fetching flight details
        this.fetchFlightBreaker = new CircuitBreaker(
            async (flightId, correlationId) => {
                const url = `${FLIGHT_SERVICE_PATH}/api/v1/flights/${flightId}`;
                const headers = {};
                if (correlationId) headers['x-correlation-id'] = correlationId;
                return await axios.get(url, { headers, timeout: breakerTimeout });
            },
            breakerOptions
        );
        this.fetchFlightBreaker.on('open', () => console.warn('[CircuitBreaker] OPEN: Flight fetch downstream is failing or slow.'));
        this.fetchFlightBreaker.on('halfOpen', () => console.log('[CircuitBreaker] HALF-OPEN: Testing Flight fetch recovery.'));
        this.fetchFlightBreaker.on('close', () => console.log('[CircuitBreaker] CLOSED: Flight fetch downstream healthy.'));

        // Circuit breaker for updating flight inventory
        this.updateInventoryBreaker = new CircuitBreaker(
            async (flightId, totalSeats, correlationId) => {
                const url = `${FLIGHT_SERVICE_PATH}/api/v1/flights/${flightId}`;
                const internalToken = process.env.INTERNAL_SERVICE_KEY || 'airline-internal-secret';
                const headers = { 'x-service-token': internalToken };
                if (correlationId) headers['x-correlation-id'] = correlationId;
                return await axios.patch(url, { totalSeats }, {
                    headers,
                    timeout: breakerTimeout
                });
            },
            breakerOptions
        );
        this.updateInventoryBreaker.on('open', () => console.warn('[CircuitBreaker] OPEN: Inventory update downstream is failing or slow.'));
        this.updateInventoryBreaker.on('halfOpen', () => console.log('[CircuitBreaker] HALF-OPEN: Testing Inventory update recovery.'));
        this.updateInventoryBreaker.on('close', () => console.log('[CircuitBreaker] CLOSED: Inventory update downstream healthy.'));
    }

    async createBooking(data) {
        let seatsDeducted = false;
        let createdBooking = null;
        let flightData = null;
        const flightId = data.flightId;

        try {
            // Step 1: Query flight inventory through Circuit Breaker
            let flightResponse;
            try {
                flightResponse = await this.fetchFlightBreaker.fire(flightId, data.correlationId);
            } catch (breakerErr) {
                if (this.fetchFlightBreaker.opened) {
                    throw new ServiceError(
                        'Flight Service is temporarily unavailable (Circuit Breaker OPEN)',
                        'Downstream Flights Service is unresponsive. Please try again later.'
                    );
                }
                throw breakerErr;
            }

            flightData = flightResponse.data.data;
            if (!flightData) {
                throw new ServiceError('Flight Not Found', `No flight found with ID ${flightId}`);
            }

            const priceOfTheFlight = flightData.price;
            if (data.noOfSeats > flightData.totalSeats) {
                throw new ServiceError('Insufficient seats in flight', `Requested ${data.noOfSeats} seats, but only ${flightData.totalSeats} are available.`);
            }

            // Step 2: Persist booking in "InProcess" state
            const totalCost = priceOfTheFlight * data.noOfSeats;
            const bookingPayload = { ...data, totalCost, status: 'InProcess' };
            createdBooking = await this.BookingRepository.create(bookingPayload);

            // Step 3: Deduct inventory through Circuit Breaker
            try {
                await this.updateInventoryBreaker.fire(flightId, flightData.totalSeats - data.noOfSeats, data.correlationId);
                seatsDeducted = true;
            } catch (inventoryErr) {
                if (this.updateInventoryBreaker.opened) {
                    throw new ServiceError(
                        'Inventory update failed (Circuit Breaker OPEN)',
                        'Unable to deduct seats. Downstream Flights Service is unresponsive.'
                    );
                }
                throw inventoryErr;
            }

            // Step 4: Confirm booking to "Booked"
            const finalBooking = await this.BookingRepository.update(createdBooking.id, { status: "Booked" });

            // Step 5: Publish event to RabbitMQ
            try {
                const channel = await createChannel();
                if (channel) {
                    const eventData = {
                        data: {
                            subject: `Booking Confirmed for Flight ${flightData.flightNumber}`,
                            content: `Your flight ${flightData.flightNumber} booking (Booking #${finalBooking.id}) is confirmed. Total Seats: ${data.noOfSeats}. Total Price: INR ${totalCost}.`,
                            recepientEmail: data.userEmail || 'customer@example.com',
                            notificationTime: new Date()
                        },
                        service: 'CREATE_TICKET',
                        correlationId: data.correlationId
                    };
                    await publishMessage(channel, REMINDER_BINDING_KEY, JSON.stringify(eventData));
                }
            } catch (queueErr) {
                console.error("Non-blocking error publishing booking event to RabbitMQ:", queueErr);
            }

            return finalBooking;

        } catch (error) {
            console.error('Error in createBooking workflow:', error.message || error);

            // Saga Compensating Action: Restore seats if previously deducted
            if (seatsDeducted && flightData) {
                console.warn(`[Saga Compensation] Restoring ${data.noOfSeats} seats for flight ${flightId}`);
                try {
                    await this.updateInventoryBreaker.fire(flightId, flightData.totalSeats, data.correlationId);
                } catch (compensationErr) {
                    console.error('[Saga Compensation] Critical error restoring seat inventory:', compensationErr);
                }
            }

            // Mark booking as Cancelled if initialized
            if (createdBooking) {
                try {
                    await this.BookingRepository.update(createdBooking.id, { status: 'Cancelled' });
                } catch (cancelErr) {
                    console.error('Failed to update booking status to Cancelled:', cancelErr);
                }
            }

            if (error.name === 'RepositoryError' || error.name === 'ValidationError' || error.name === 'ServiceError') {
                throw error;
            }
            throw new ServiceError('Booking workflow failed', error.message || 'Internal service error');
        }
    }

    async getBookingsByUser(userId) {
        try {
            const bookings = await this.BookingRepository.getByUserId(userId);
            return bookings;
        } catch (error) {
            throw error;
        }
    }

    async getAllBookings() {
        try {
            const bookings = await this.BookingRepository.getAll();
            return bookings;
        } catch (error) {
            throw error;
        }
    }

    async getBooking(bookingId) {
        try {
            const booking = await this.BookingRepository.get(bookingId);
            return booking;
        } catch (error) {
            throw error;
        }
    }

    async cancelBooking(bookingId, requesterUserId, isAdmin = false, correlationId = null) {
        try {
            const booking = await this.BookingRepository.get(bookingId);
            if (!booking) {
                throw new ServiceError('Booking Not Found', `No booking exists with ID ${bookingId}`);
            }

            // Authorization verification (IDOR protection)
            if (requesterUserId && booking.userId !== requesterUserId && !isAdmin) {
                throw new ServiceError('Forbidden', "You are not authorized to cancel another customer's booking.");
            }

            if (booking.status === 'Cancelled') {
                throw new ServiceError('Already Cancelled', 'This booking itinerary is already marked as Cancelled.');
            }

            // Step 1: Query current flight inventory through Circuit Breaker
            let flightData = null;
            try {
                const flightResponse = await this.fetchFlightBreaker.fire(booking.flightId, correlationId);
                flightData = flightResponse.data.data;
            } catch (fetchErr) {
                console.warn('[Booking Cancellation] Downstream flight fetch warning:', fetchErr.message);
            }

            // Step 2: Compensate inventory: Restock reserved seats in Flights Service
            if (flightData) {
                const restoredSeats = (flightData.totalSeats || 0) + (booking.noOfSeats || 1);
                console.log(`[Saga Compensation] Restoring ${booking.noOfSeats} seats to flight #${booking.flightId}. New seat count: ${restoredSeats}`);
                try {
                    await this.updateInventoryBreaker.fire(booking.flightId, restoredSeats, correlationId);
                } catch (updateErr) {
                    console.error('[Saga Compensation] Error replenishing seats in flight service:', updateErr.message);
                }
            }

            // Step 3: Update booking status to 'Cancelled'
            const updatedBooking = await this.BookingRepository.update(bookingId, { status: 'Cancelled' });

            // Step 4: Publish cancellation notification event to RabbitMQ
            try {
                const channel = await createChannel();
                if (channel) {
                    const eventData = {
                        data: {
                            subject: `Booking #${booking.id} Cancelled`,
                            content: `Your flight reservation (Booking #${booking.id}) has been successfully cancelled. ${booking.noOfSeats} seat(s) restored. Refund initiated.`,
                            recepientEmail: 'customer@skyflow.com',
                            notificationTime: new Date()
                        },
                        service: 'CANCEL_TICKET',
                        correlationId: correlationId
                    };
                    await publishMessage(channel, REMINDER_BINDING_KEY, JSON.stringify(eventData));
                }
            } catch (queueErr) {
                console.error("Non-blocking error publishing cancellation event to RabbitMQ:", queueErr);
            }

            const rawCost = updatedBooking.totalCost || 0;
            return {
                booking: updatedBooking,
                refundAmount: Math.round(rawCost * 0.9),
                cancellationFee: Math.round(rawCost * 0.1),
                restoredSeats: booking.noOfSeats
            };
        } catch (error) {
            console.error('Error in cancelBooking workflow:', error.message || error);
            if (error.name === 'RepositoryError' || error.name === 'ValidationError' || error.name === 'ServiceError') {
                throw error;
            }
            throw new ServiceError('Booking cancellation failed', error.message || 'Internal service error');
        }
    }
}

module.exports = BookingService;