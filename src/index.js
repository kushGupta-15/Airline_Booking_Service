const express = require('express');
const {PORT} = require('./config/serverConfig.js');
const apiRoutes = require('./routes/index.js');
const db = require('./models/index.js');


const app = express();

const setupAndStartServer = () => {

    app.use(express.json());
    app.use(express.urlencoded({ extended: true}));

    app.use('/api', apiRoutes);

    app.listen(PORT, () => {
        console.log(`Server started on port ${PORT}`);
        if(process.env.DB_SYNC) {
            db.sequelize.sync({alter: true});
        }
    });
}

setupAndStartServer();