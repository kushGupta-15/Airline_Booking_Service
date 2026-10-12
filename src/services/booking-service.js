const {BookingRepository} = require('../repository/index.js');
const axios = require('axios')
const {FLIGHT_SERVICE_PATH, REMINDER_BINDING_KEY} = require('../config/serverConfig.js');
const { ServiceError } = require('../utils/errors/index.js');
const { createChannel, publishMessage } = require('../utils/messageQueue.js');
class BookingService {
    constructor() {
        this.BookingRepository = new BookingRepository();
    }

    async createBooking(data) {
        try {
            const flightId = data.flightId;
            console.log(flightId);
            
            const getFlightRequestURL = `${FLIGHT_SERVICE_PATH}/api/v1/flights/${flightId}`;
            const response = await axios.get(getFlightRequestURL)
            // console.log(response);
            
            const flightData = response.data.data;
            // console.log(flightData);
            let priceOfTheFlight = flightData.price;
            if(data.noOfSeats > flightData.totalSeats) {
                throw new ServiceError('Something went wrong in the booking process', 'Insufficient seats in flight')
            }

            const totalCost = priceOfTheFlight * data.noOfSeats;
            const bookingPayload = {...data, totalCost};
            const booking = await this.BookingRepository.create(bookingPayload);

            const updateFlightRequestURL = `${FLIGHT_SERVICE_PATH}/api/v1/flights/${flightId}`;
            await axios.patch(updateFlightRequestURL, {totalSeats: flightData.totalSeats - booking.noOfSeats});

            const finalBooking = await this.BookingRepository.update(booking.id, {status: "Booked"});
            
            try {
                const channel = await createChannel();
                if (channel) {
                    const eventData = {
                        data: {
                            subject: `Booking Confirmed for Flight ${flightData.flightNumber}`,
                            content: `Your flight ${flightData.flightNumber} booking (Booking #${finalBooking.id}) is confirmed. Total Seats: ${booking.noOfSeats}. Total Price: INR ${totalCost}.`,
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
            console.error('Error in createBooking:', error); // Log the error for debugging
            if(error.name == 'RepositoryError' || error.name == 'ValidationError') {
                throw error;
            }
            throw new ServiceError();
        }
    }
}

module.exports = BookingService;