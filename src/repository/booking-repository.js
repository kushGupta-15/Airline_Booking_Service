const {Booking} = require('../models/index.js');
const {StatusCodes} = require('http-status-codes');
const { ValidationError, AppError } = require('../utils/errors/index.js');

class BookingRepository {
    async create(data) {
        try {
            const booking = await Booking.create(data);
            return booking;
        } catch (error) {
            if(error.name == 'SequelizeValidationError'){
                throw new ValidationError(error);
            }
            throw new AppError('RepositoryError', 'Cannot create Booking', 'There was some issue creating the booking, Please try again later', StatusCodes.INTERNAL_SERVER_ERROR)
        }
    }

    async update(bookingId, data) {
        try {
            const booking = await Booking.findByPk(bookingId);
            if(data.status) {
                booking.status = data.status;
            }
            await booking.save();
            return booking;
        } catch (error) {
            throw new AppError('RepositoryError', 'Cannot update Booking', 'There was some issue updating the booking, please try again later', StatusCodes.INTERNAL_SERVER_ERROR);
        }
    }

    async get(bookingId) {
        try {
            const booking = await Booking.findByPk(bookingId);
            return booking;
        } catch (error) {
            throw new AppError('RepositoryError', 'Cannot fetch Booking', 'There was some issue fetching the booking', StatusCodes.INTERNAL_SERVER_ERROR);
        }
    }

    async getByUserId(userId) {
        try {
            const bookings = await Booking.findAll({
                where: { userId },
                order: [['createdAt', 'DESC']]
            });
            return bookings;
        } catch (error) {
            throw new AppError('RepositoryError', 'Cannot fetch User Bookings', 'There was some issue fetching bookings', StatusCodes.INTERNAL_SERVER_ERROR);
        }
    }

    async getAll() {
        try {
            const bookings = await Booking.findAll({
                order: [['createdAt', 'DESC']]
            });
            return bookings;
        } catch (error) {
            throw new AppError('RepositoryError', 'Cannot fetch Bookings', 'There was some issue fetching bookings', StatusCodes.INTERNAL_SERVER_ERROR);
        }
    }
}

module.exports = BookingRepository;