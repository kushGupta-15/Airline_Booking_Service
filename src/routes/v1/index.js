const express = require('express');
const {BookingController} = require('../../controllers/index.js');
const {BookingMiddlewares} = require('../../middlewares/index.js');

const router = express.Router();

const bookingController = new BookingController();
router.post('/bookings', BookingMiddlewares.validateCreateBooking, bookingController.create);
router.get('/bookings', bookingController.getAll);
router.get('/bookings/:id', bookingController.get);
router.post('/publish', bookingController.sendMessageToQueue);
module.exports = router;