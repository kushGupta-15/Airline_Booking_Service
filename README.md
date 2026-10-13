# 🎫 SkyFlow Airline Booking Service

[![Production Booking Service](https://img.shields.io/badge/Production-Live%20on%20Render-success?style=for-the-badge&logo=render)](https://skyflow-booking-service-77ep.onrender.com/health)
[![Node.js](https://img.shields.io/badge/Node.js-v18.0.0+-green?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-v5.0-black?style=for-the-badge&logo=express)](https://expressjs.com/)
[![Sequelize ORM](https://img.shields.io/badge/Sequelize-v6.0-52B0E7?style=for-the-badge&logo=sequelize)](https://sequelize.org/)
[![Opossum Circuit Breaker](https://img.shields.io/badge/Circuit_Breaker-Opossum-yellow?style=for-the-badge)](https://nodeshift.dev/opossum/)
[![RabbitMQ](https://img.shields.io/badge/RabbitMQ-AMQP%20Broker-FF6600?style=for-the-badge&logo=rabbitmq)](https://www.rabbitmq.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Multi--Dialect-336791?style=for-the-badge&logo=postgresql)](https://www.postgresql.org/)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

The **SkyFlow Airline Booking Service** is the transaction coordinator and seat lifecycle management microservice. It manages passenger reservations, coordinates distributed seat deductions against the **Flights Service** using **Opossum Circuit Breakers**, enforces customer IDOR identity isolation, publishes asynchronous notification events to **RabbitMQ**, and executes self-service trip cancellation sagas with automatic seat replenishment.

---

## 🏗️ System Architecture & Integration Context

The Booking Service sits between the client gateway, the inventory catalog service, the message broker, and the persistent relational database:

```mermaid
flowchart TD
    GW(["SkyFlow API Gateway (:3005)<br/>(Injects x-user-id & x-is-admin)"])

    subgraph BookingServiceBoundary ["Airline Booking Service (:3002 / Render)"]
        Routes["Express Router (/api/v1/bookings)"]

        subgraph SecurityIsolation ["Identity & IDOR Protection"]
            OwnershipGuard["Customer Ownership Guard<br/>• Non-admins restricted to own bookings (userId matching)<br/>• Admins permitted global manifest access"]
        end

        BookingCtrl["Booking Controller"]
        BookingSvc["Booking Service (Transaction Orchestrator)"]

        subgraph ResilienceEngine ["Resilience & Fault Tolerance"]
            CBFetch["Opossum Circuit Breaker<br/>(fetchFlightBreaker • 10s Timeout)"]
            CBUpdate["Opossum Circuit Breaker<br/>(updateInventoryBreaker • 10s Timeout)"]
        end

        subgraph EventBusEngine ["Asynchronous Event Publisher"]
            MQPublisher["RabbitMQ Publisher (amqplib)<br/>• Non-blocking connection guard<br/>• Topic Exchange: AIRLINE_BUS"]
        end

        BookingRepo["Booking Repository<br/>(Sequelize Data Access Layer)"]
    end

    subgraph ExternalServices ["External Microservices & Infrastructure"]
        FlightSvc["Flights & Search Service (:3000)<br/>• GET /flights/:id (Price & Seats)<br/>• PATCH /flights/:id (x-service-token)"]
        RabbitMQ[("RabbitMQ Broker (:5672)<br/>Queue: REMINDER_SERVICE")]
        ReminderSvc["Airline Reminder Service (:3004)"]
        RelationalStore[("Relational Database (PostgreSQL / MySQL)<br/>Table: Bookings")]
    end

    GW -->|POST /bookings, GET /bookings, PATCH /cancel| Routes
    Routes --> OwnershipGuard
    OwnershipGuard --> BookingCtrl
    BookingCtrl --> BookingSvc
    BookingSvc <--> ResilienceEngine
    ResilienceEngine -->|Inter-Service HTTP Requests| FlightSvc
    BookingSvc --> EventBusEngine
    EventBusEngine -->|Publish Booking & Cancel Events| RabbitMQ
    RabbitMQ -->|Consume Event| ReminderSvc
    BookingSvc --> BookingRepo
    BookingRepo <--> RelationalStore

    classDef clientStyle fill:#1e1b4b,stroke:#8b5cf6,stroke-width:2px,color:#f8fafc;
    classDef svcStyle fill:#0f172a,stroke:#3b82f6,stroke-width:2px,color:#f8fafc;
    classDef extStyle fill:#1e293b,stroke:#10b981,stroke-width:2px,color:#f8fafc;

    class GW clientStyle;
    class BookingServiceBoundary,Routes,SecurityIsolation,BookingCtrl,BookingSvc,ResilienceEngine,EventBusEngine,BookingRepo svcStyle;
    class ExternalServices,FlightSvc,RabbitMQ,ReminderSvc,RelationalStore extStyle;
```

---

## 🔄 Booking & Cancellation Transaction Workflows

### 1. Interactive Booking Workflow
```mermaid
sequenceDiagram
    autonumber
    actor Client as Passenger / API Gateway
    participant BS as Booking Service (:3002)
    participant CB as Opossum Circuit Breaker
    participant FS as Flight Service (:3000)
    participant DB as Bookings Database
    participant MQ as RabbitMQ Broker

    Client->>BS: POST /api/v1/bookings (flightId, noOfSeats, userEmail)
    BS->>CB: Execute fetchFlightBreaker
    CB->>FS: GET /api/v1/flights/:flightId
    FS-->>CB: Flight Details (price, totalSeats)
    CB-->>BS: Flight Data
    Note over BS: Validate: totalSeats >= requested seats<br/>Compute: totalCost = price * noOfSeats
    BS->>DB: INSERT Booking (status: InProcess, totalCost)
    BS->>CB: Execute updateInventoryBreaker
    CB->>FS: PATCH /api/v1/flights/:flightId { totalSeats: totalSeats - noOfSeats }<br/>[Header: x-service-token]
    FS-->>CB: 200 OK (Seats Deducted)
    CB-->>BS: Success
    BS->>DB: UPDATE Booking (status: Booked)
    opt Async Event Notification
        BS->>MQ: Publish { recipientEmail, subject, content } to AIRLINE_BUS
    end
    BS-->>Client: 200 OK (Confirmed Booking Details)
```

### 2. Self-Service Cancellation Saga & Seat Restock
```mermaid
sequenceDiagram
    autonumber
    actor Client as Passenger / API Gateway
    participant BS as Booking Service (:3002)
    participant DB as Bookings Database
    participant CB as Opossum Circuit Breaker
    participant FS as Flight Service (:3000)
    participant MQ as RabbitMQ Broker

    Client->>BS: PATCH /api/v1/bookings/:id/cancel
    Note over BS: Verify ownership (x-user-id matches booking.userId)
    BS->>DB: Fetch booking details (flightId, noOfSeats, totalCost)
    Note over BS: Compute Refund (90% Net Refund, 10% Cancellation Fee)
    BS->>CB: Execute updateInventoryBreaker
    CB->>FS: PATCH /api/v1/flights/:flightId { totalSeats: totalSeats + noOfSeats }
    FS-->>CB: 200 OK (Seats Restocked)
    BS->>DB: UPDATE Booking (status: Cancelled)
    BS->>MQ: Publish Cancellation Event to AIRLINE_BUS
    BS-->>Client: 200 OK (Cancellation Breakdown & Refund Amount)
```

---

## 📊 Database Domain Model (ER Diagram)

```mermaid
erDiagram
    BOOKING {
        int id PK "Auto Increment"
        int flightId "ID of booked flight"
        int userId "ID of customer account"
        string status "InProcess | Booked | Cancelled"
        int noOfSeats "Total passenger seats reserved"
        int totalCost "Total ticket airfare (INR)"
        datetime createdAt
        datetime updatedAt
    }
```

---

## ⚡ Core Capabilities

1. **Opossum Circuit Breaker Protection**:
   - Both `fetchFlightBreaker` and `updateInventoryBreaker` are configured with a 10-second timeout (`CIRCUIT_BREAKER_TIMEOUT`) and a 10-second half-open cooldown to tolerate downstream cold starts without crashing or cascading failures.
2. **Customer Identity Isolation (Anti-IDOR)**:
   - When a passenger calls `GET /bookings` or `PATCH /bookings/:id/cancel`, the service extracts `x-user-id` and `x-is-admin` from the gateway. Non-admin passengers can only access and cancel their own bookings.
3. **Resilient Message Broker Handling**:
   - Safely guards RabbitMQ connections: if `MESSAGE_BROKER_URL` is omitted or temporarily offline, booking requests continue without blocking.
4. **Transparent Cancellation Saga**:
   - Restocks inventory in the Flights service and records a 90% net refund breakdown.

---

## 🛠️ Tech Stack & Dependencies

| Category | Technology | Description |
| :--- | :--- | :--- |
| **Runtime** | Node.js (v18+) | Server execution runtime |
| **Framework** | Express 5 | REST API web framework |
| **ORM** | Sequelize v6 | Relational Object-Relational Mapping |
| **Circuit Breaker** | `opossum` | Fault-tolerant circuit breaker pattern |
| **Message Broker** | `amqplib` | RabbitMQ AMQP 0-9-1 messaging client |
| **Databases** | PostgreSQL & MySQL | Relational engines via `pg` and `mysql2` |
| **HTTP Client** | `axios` | Downstream communication with Flight Service |

---

## 🌐 API Endpoints & Request Contract

### 1. Create Flight Booking
- **Endpoint**: `POST /api/v1/bookings`
- **Access**: Protected (Requires `x-access-token` via Gateway)
- **Request Body**:
  ```json
  {
    "flightId": 1,
    "noOfSeats": 2,
    "userEmail": "passenger@skyflow.com"
  }
  ```
- **Response** (`200 OK`):
  ```json
  {
    "success": true,
    "message": "Successfully created booking",
    "data": {
      "id": 2,
      "flightId": 1,
      "userId": 4,
      "status": "Booked",
      "noOfSeats": 2,
      "totalCost": 11200,
      "createdAt": "2026-10-13T06:04:19.000Z",
      "updatedAt": "2026-10-13T06:04:20.000Z"
    },
    "err": {}
  }
  ```

### 2. Retrieve Bookings (Passenger or Admin)
- **Endpoint**: `GET /api/v1/bookings`
- **Access**: Protected (Returns current user's bookings, or all bookings for `ADMIN`)
- **Headers**: `x-user-id: 4`, `x-is-admin: false`
- **Response** (`200 OK`):
  ```json
  {
    "success": true,
    "message": "Successfully fetched bookings",
    "data": [
      {
        "id": 2,
        "flightId": 1,
        "userId": 4,
        "status": "Booked",
        "noOfSeats": 2,
        "totalCost": 11200
      }
    ],
    "err": {}
  }
  ```

### 3. Cancel Booking (Self-Service Trip Cancellation)
- **Endpoint**: `PATCH /api/v1/bookings/:id/cancel`
- **Access**: Protected (Passenger owner or Admin)
- **Headers**: `x-user-id: 4`, `x-is-admin: false`
- **Response** (`200 OK`):
  ```json
  {
    "success": true,
    "message": "Booking successfully cancelled and seat inventory replenished",
    "data": {
      "bookingId": 2,
      "flightId": 1,
      "status": "Cancelled",
      "refundAmount": 10080,
      "processingFee": 1120,
      "seatsRestocked": 2
    },
    "err": {}
  }
  ```

### 4. Health Probe
- **Endpoint**: `GET /health`
- **Response** (`200 OK`):
  ```json
  {
    "service": "Airline_Booking_Service",
    "status": "UP",
    "database": "CONNECTED",
    "timestamp": "2026-10-13T06:09:26.300Z"
  }
  ```

---

## ⚙️ Environment Variables

Create a `.env` file in `Airline_Booking_Service`:

| Variable | Required | Default / Example | Description |
| :--- | :---: | :--- | :--- |
| `PORT` | **Yes** | `3002` (Local) / `10000` (Render) | Server listening port. |
| `FLIGHT_SERVICE_PATH` | **Yes** | `https://skyflow-search-service.onrender.com` | Base URL of the Flights & Search Service. |
| `DATABASE_URL` | Optional | `postgres://user:pass@host/db` | Connection URI for cloud databases (Render PostgreSQL). |
| `MESSAGE_BROKER_URL` | Optional | `amqp://localhost:5672` | RabbitMQ connection URI. |
| `EXCHANGE_NAME` | Optional | `AIRLINE_BUS` | RabbitMQ topic exchange name. |
| `REMINDER_BINDING_KEY`| Optional | `REMINDER_SERVICE` | RabbitMQ routing key for notification events. |
| `CIRCUIT_BREAKER_TIMEOUT`| Optional | `10000` | Circuit breaker timeout in milliseconds (default: 10s). |
| `INTERNAL_SERVICE_KEY`| Optional | `airline-internal-secret` | Shared secret header forwarded to Flights Service. |
| `DB_SYNC` | Optional | `false` | When set to `true`, auto-syncs models on startup. |
| `NODE_ENV` | Optional | `development` | Operating environment (`development`, `production`). |

---

## 🚀 Local Development & Setup

### Prerequisites
- **Node.js**: `v18.0.0` or higher
- **MySQL**: Running on `127.0.0.1:3306` (or PostgreSQL)
- **RabbitMQ**: Running on `127.0.0.1:5672` (optional)
- **Flights & Search Service**: Running on port `3000`

### Step-by-Step Instructions

1. **Navigate to Service:**
   ```bash
   cd Airline_Booking_Service
   ```

2. **Install Dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment & Database:**
   ```bash
   cp .env.example .env
   cp src/config/config.json.example src/config/config.json
   ```

4. **Apply Schema Migrations:**
   ```bash
   npx sequelize db:create
   npx sequelize db:migrate
   ```

5. **Start Service:**
   ```bash
   npm start
   ```
   Service will listen on `http://localhost:3002`.

---

## 🐳 Docker Compose (Dependencies & Service)

```yaml
version: '3.8'

services:
  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"
      - "15672:15672"
    environment:
      RABBITMQ_DEFAULT_USER: guest
      RABBITMQ_DEFAULT_PASS: guest

  booking-service:
    build: .
    ports:
      - "3002:3002"
    environment:
      - PORT=3002
      - FLIGHT_SERVICE_PATH=http://flight-service:3000
      - MESSAGE_BROKER_URL=amqp://rabbitmq:5672
    depends_on:
      - rabbitmq
```

---

## 📄 License
This project is licensed under the MIT License.
