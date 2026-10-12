const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const {PORT} = require('./config/serverConfig.js');
const apiRoutes = require('./routes/index.js');
const db = require('./models/index.js');


const app = express();

const setupAndStartServer = () => {

    app.use(helmet());
    app.use(cors());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true}));

    app.use('/api', apiRoutes);
    app.use('/bookingservice/api', apiRoutes);

    app.get('/health', async (req, res) => {
        try {
            await db.sequelize.authenticate();
            return res.status(200).json({
                service: 'Airline_Booking_Service',
                status: 'UP',
                database: 'CONNECTED',
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            return res.status(503).json({
                service: 'Airline_Booking_Service',
                status: 'DEGRADED',
                database: 'DISCONNECTED',
                error: error.message
            });
        }
    });

    app.listen(PORT, () => {
        console.log(`Server started on port ${PORT}`);
        // if(process.env.DB_SYNC) {
        //     db.sequelize.sync({alter: true});
        // }
    });
}

setupAndStartServer();