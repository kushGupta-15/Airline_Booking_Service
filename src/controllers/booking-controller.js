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
            const bookingPayload = {
                ...req.body,
                userId: req.headers['x-user-id'] ? parseInt(req.headers['x-user-id'], 10) : req.body.userId,
                correlationId: req.correlationId || req.headers['x-correlation-id']
            };
            const response = await bookingService.createBooking(bookingPayload);
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
        });
    }

    async getUserBookings(req, res) {
        try {
            const userId = req.headers['x-user-id'] ? parseInt(req.headers['x-user-id'], 10) : parseInt(req.params.userId, 10);
            const response = await bookingService.getBookingsByUser(userId);
            return res.status(StatusCodes.OK).json({
                message: "User bookings fetched successfully",
                data: response,
                success: true,
                err: {}
            });
        } catch (error) {
            return res.status(error.statusCode || StatusCodes.INTERNAL_SERVER_ERROR).json({
                message: error.message || 'Cannot fetch user bookings',
                success: false,
                err: error.explanation || error,
                data: []
            });
        }
    }

    async getAll(req, res) {
        try {
            const userId = req.headers['x-user-id'] ? parseInt(req.headers['x-user-id'], 10) : null;
            let response;
            if (userId) {
                response = await bookingService.getBookingsByUser(userId);
            } else {
                response = await bookingService.getAllBookings();
            }
            return res.status(StatusCodes.OK).json({
                message: "Bookings fetched successfully",
                data: response,
                success: true,
                err: {}
            });
        } catch (error) {
            return res.status(error.statusCode || StatusCodes.INTERNAL_SERVER_ERROR).json({
                message: error.message || 'Cannot fetch bookings',
                success: false,
                err: error.explanation || error,
                data: []
            });
        }
    }

    async get(req, res) {
        try {
            const response = await bookingService.getBooking(req.params.id);
            return res.status(StatusCodes.OK).json({
                message: "Booking fetched successfully",
                data: response,
                success: true,
                err: {}
            });
        } catch (error) {
            return res.status(error.statusCode || StatusCodes.INTERNAL_SERVER_ERROR).json({
                message: error.message || 'Cannot fetch booking',
                success: false,
                err: error.explanation || error,
                data: {}
            });
        }
    }
}


module.exports = BookingController