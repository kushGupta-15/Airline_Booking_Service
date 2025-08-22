const {StatusCodes} = require('http-status-codes');
const {BookingService} = require('../services/index');
const {createChannel, publishMessage} = require('../utils/messageQueue.js')
const {REMINDER_BIDING_KEY} = require('../config/serverConfig.js');
const bookingService = new BookingService();

class BookingController {
    constructor() {

    }
    async create(req, res) {
        try {
            const response = await bookingService.createBooking(req.body);
            return res.status(StatusCodes.OK).json({
                message: "Booking created successfully",
                data: response,
                success: true,
                err: {}
            });
        } catch (error) {
            return res.status(error.statusCode || StatusCodes.INTERNAL_SERVER_ERROR).json({
                message: error.message,
                success: false,
                err: error.explanation,
                data: {}
            });
        }
    }

    async sendMessageToQueue (req, res) {
        const channel = await createChannel();
        const data = {message: 'SUCCESS'};
        publishMessage(channel, REMINDER_BIDING_KEY, JSON.stringify(data));
        return res.status(200).json({
            message: 'Successfuly publeshed th event'
        })
    }
}


module.exports = BookingController