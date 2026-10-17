# Smart Attendance System - Backend

REST API for the Smart Attendance System. A student's attendance is recorded only after the
server has verified they are physically in the classroom:

```
Teacher opens a session ─► Student taps "Mark Attendance"
                                   │
              BLE proximity ─► (Dynamic QR, optional) ─► Face liveness
                                   │
                         Server checks every required proof
                                   │
                         Attendance recorded (once per session)
```

* **Zero npm dependencies.** Plain Node.js (`http`, `crypto`) + the built-in SQLite module.
* Requires **Node.js 22.13 or newer**.

## Quick start

```bash
cd backend
cp .env.example .env      # optional - defaults work for development
npm start                 # http://localhost:4000
npm test                  # 9 end-to-end tests against an in-memory database
```

On first start with an empty database, demo data is created:

| Role    | Login ID                | Password                                         |
|---------|-------------------------|--------------------------------------------------|
| Teacher | `T001`                  | `teacher123`                                     |
| Student | `23BCS001` … `23BCS005` | `student123` (not needed in dev mode, see below) |

Courses: Introduction to Programming (`CS101`), Computer Networks (`CN301`), Information Retrieval (`IR302`),
each scheduled every day so the demo works whenever you run it. All five students are enrolled in all three.

Try it:

```bash
# teacher logs in and opens attendance for Computer Networks (course id 2)
T=$(curl -s localhost:4000/api/auth/login -H 'Content-Type: application/json' \
     -d '{"loginId":"T001","password":"teacher123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s localhost:4000/api/sessions -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"courseId":2}'
```

The student side (login → dashboard → BLE → face → complete) is documented in [`docs/api.md`](docs/api.md),
including ready-to-paste code for your React pages.

## How each check works

| Check | What the server enforces |
|-------|--------------------------|
| **BLE proximity** | Client reports the beacon ID it saw + RSSI. Beacon must match the one assigned to the session, and RSSI must be ≥ `BLE_MIN_RSSI` (default −80 dBm). |
| **Dynamic QR** | Teacher screen polls `GET /api/sessions/:code/qr`; the server mints a new token every `QR_TTL_SECONDS` (5 s). Student submits the scanned token; it must belong to that session and be unexpired (plus a small grace for network delay). |
| **Face liveness** | Server issues a random, single-use, 30-second challenge (e.g. *blink + turn left*). The result must reference that challenge, arrive no faster than humanly possible, and meet `LIVENESS_MIN_SCORE`. |
| **Completion** | `complete` fails unless every factor in `REQUIRED_FACTORS` is verified, the attempt hasn't timed out, and the session is still open. A DB `UNIQUE(session, student)` constraint guarantees one record per student per session, even under double-taps. |

Failed verifications are written to an `audit_log` table so repeated suspicious attempts are visible.

## Configuration (`.env`)

See [`.env.example`](.env.example) - every option is documented there. The important ones:

* `REQUIRED_FACTORS` - `ble,face` (default, matches your current UI flow) or `ble,qr,face`, etc.
* `REQUIRE_PASSWORD` - **`false` by default so your current login screen (ID only) works. This is for development only:** anyone who knows a student ID can log in as that student. Turn it on as soon as the login page has a password field.
* `JWT_SECRET` - **required** when `NODE_ENV=production`.

## Project layout

```
backend/
├── src/
│   ├── server.js            HTTP server, CORS, JSON parsing, error handling
│   ├── router.js            tiny router with role-based access
│   ├── config.js            env loading + validation
│   ├── db.js                SQLite schema, transactions, audit log
│   ├── auth.js              scrypt passwords, signed tokens (HS256), login limiter
│   ├── seed.js              demo data (`npm run seed`)
│   ├── routes/              auth, student, attendance, teacher
│   └── services/            ble, qr, liveness, attendance, schedule
├── test/api.test.js
└── docs/api.md              endpoint reference + frontend integration
```

## Known limitations (please read before relying on this for real grading)

1. **Face liveness is client-reported.** Your face module doesn't exist yet, so the server accepts
   `{ passed, score }` from the browser. The challenge/nonce/expiry logic stops *replay*, but a
   determined user could still forge a passing result. When the real model is ready, implement it in
   `evaluateLiveness()` in `src/services/liveness.js` (e.g. upload frames to a Python/ONNX service
   and use its verdict) - that is the only function that needs to change.
2. **BLE is also client-reported** (beacon ID + RSSI). A static beacon ID can be relayed by a friend inside
   the room. Mitigations to consider later: a beacon that broadcasts a rotating code the server can check,
   and combining BLE with the dynamic QR (`REQUIRED_FACTORS=ble,qr,face`). Also note browser support:
   Web Bluetooth works in Chrome/Edge on Android and desktop, **not on iOS Safari**.
3. **Dev-mode login** (see `REQUIRE_PASSWORD` above).
4. SQLite is perfect for a single server and a class-sized load. Move to PostgreSQL if you ever need multiple servers.
5. Run behind HTTPS in any real deployment (camera and Bluetooth APIs require a secure context anyway).
