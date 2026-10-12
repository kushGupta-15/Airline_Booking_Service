const { z } = require('zod');
const { StatusCodes } = require('http-status-codes');

const createBookingSchema = z.object({
    flightId: z.coerce.number({ required_error: 'Flight ID is required' }).int().positive('Flight ID must be a positive integer'),
    noOfSeats: z.coerce.number({ required_error: 'Number of seats is required' }).int().positive('Number of seats must be at least 1')
});

const validateCreateBooking = (req, res, next) => {
    const result = createBookingSchema.safeParse(req.body);
    if (!result.success) {
        return res.status(StatusCodes.BAD_REQUEST).json({
            message: 'Invalid request body for booking',
            success: false,
            err: (result.error.issues || []).map(e => e.message).join(', '),
            data: {}
        });
    }
    next();
};

module.exports = {
    validateCreateBooking
};
