const express = require('express');
const {BookingController} = require('../../controllers/index.js');
// const {createChannel} = require('../../utils/messageQueue.js');

const router = express.Router();

// const channel = await createChannel();
const bookingController = new BookingController();
router.post('/bookings', bookingController.create);
router.post('/publish', bookingController.sendMessageToQueue);
module.exports = router;