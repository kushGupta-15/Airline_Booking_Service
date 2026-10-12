const { BookingRepository } = require('../repository/index.js');
const axios = require('axios');
const CircuitBreaker = require('opossum');
const { FLIGHT_SERVICE_PATH, REMINDER_BINDING_KEY } = require('../config/serverConfig.js');
const { ServiceError } = require('../utils/errors/index.js');
const { createChannel, publishMessage } = require('../utils/messageQueue.js');

const breakerOptions = {
    timeout: 3000, // Trigger failure if response exceeds 3000ms
    errorThresholdPercentage: 50, // Open breaker if >= 50% requests fail
    resetTimeout: 10000 // Try half-open test after 10 seconds
};

class BookingService {
    constructor() {
        this.BookingRepository = new BookingRepository();

        // Circuit breaker for fetching flight details
        this.fetchFlightBreaker = new CircuitBreaker(
            async (flightId) => {
                const url = `${FLIGHT_SERVICE_PATH}/api/v1/flights/${flightId}`;
                return await axios.get(url, { timeout: 3000 });
            },
            breakerOptions
        );
        this.fetchFlightBreaker.on('open', () => console.warn('[CircuitBreaker] OPEN: Flight fetch downstream is failing or slow.'));
        this.fetchFlightBreaker.on('halfOpen', () => console.log('[CircuitBreaker] HALF-OPEN: Testing Flight fetch recovery.'));
        this.fetchFlightBreaker.on('close', () => console.log('[CircuitBreaker] CLOSED: Flight fetch downstream healthy.'));

        // Circuit breaker for updating flight inventory
        this.updateInventoryBreaker = new CircuitBreaker(
            async (flightId, totalSeats) => {
                const url = `${FLIGHT_SERVICE_PATH}/api/v1/flights/${flightId}`;
                const internalToken = process.env.INTERNAL_SERVICE_KEY || 'airline-internal-secret';
                return await axios.patch(url, { totalSeats }, {
                    headers: { 'x-service-token': internalToken },
                    timeout: 3000
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
                flightResponse = await this.fetchFlightBreaker.fire(flightId);
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
                await this.updateInventoryBreaker.fire(flightId, flightData.totalSeats - data.noOfSeats);
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
                        service: 'CREATE_TICKET'
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
                    await this.updateInventoryBreaker.fire(flightId, flightData.totalSeats);
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
}

module.exports = BookingService;