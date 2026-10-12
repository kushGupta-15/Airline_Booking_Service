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
            const requesterUserId = req.headers['x-user-id'] ? parseInt(req.headers['x-user-id'], 10) : null;
            const targetUserId = req.params.userId ? parseInt(req.params.userId, 10) : requesterUserId;
            const isAdmin = req.headers['x-is-admin'] === 'true';

            // IDOR Protection: Non-admin users can only view their own bookings
            if (requesterUserId && targetUserId !== requesterUserId && !isAdmin) {
                return res.status(StatusCodes.FORBIDDEN).json({
                    message: "Forbidden: You are not authorized to access another customer's bookings.",
                    success: false,
                    err: "Unauthorized Access",
                    data: []
                });
            }

            const response = await bookingService.getBookingsByUser(targetUserId || requesterUserId);
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
            const requesterUserId = req.headers['x-user-id'] ? parseInt(req.headers['x-user-id'], 10) : null;
            const isAdmin = req.headers['x-is-admin'] === 'true';
            let response;

            // Non-admin requests are automatically scoped to the authenticated user ID
            if (requesterUserId && !isAdmin) {
                response = await bookingService.getBookingsByUser(requesterUserId);
            } else if (isAdmin) {
                response = await bookingService.getAllBookings();
            } else {
                return res.status(StatusCodes.UNAUTHORIZED).json({
                    message: "Unauthorized: Missing identity headers.",
                    success: false,
                    data: []
                });
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
            if (!response) {
                return res.status(StatusCodes.NOT_FOUND).json({
                    message: "Booking itinerary not found.",
                    success: false,
                    data: null
                });
            }

            const requesterUserId = req.headers['x-user-id'] ? parseInt(req.headers['x-user-id'], 10) : null;
            const isAdmin = req.headers['x-is-admin'] === 'true';

            // IDOR Protection: Verify ownership
            if (requesterUserId && response.userId !== requesterUserId && !isAdmin) {
                return res.status(StatusCodes.FORBIDDEN).json({
                    message: "Forbidden: You are not authorized to view this booking itinerary.",
                    success: false,
                    data: null
                });
            }

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