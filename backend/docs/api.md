# API reference

Base URL (dev): `http://localhost:4000`. All bodies are JSON. Authenticated routes need
`Authorization: Bearer <token>` (from `/api/auth/login`).

Errors always look like:

```json
{ "error": { "code": "BLE_TOO_FAR", "message": "You appear to be outside…", "details": {} } }
```

Show `error.message` to the user; branch on `error.code` in code.

## Auth

| Method & path | Who | Body → Response |
|---|---|---|
| `POST /api/auth/login` | public | `{ studentId or loginId, password? }` → `{ token, user:{id,loginId,name,role} }`. Teachers always need a password; students only if `REQUIRE_PASSWORD=true`. |
| `GET /api/auth/me` | any | → `{ user }` |

## Student

| Method & path | Response |
|---|---|
| `GET /api/student/dashboard` | `{ student, summary:{overallAttendance, classesToday, presentToday}, classes:[{courseId, code, name, timeLabel, activeSessionCode, canMarkAttendance, marked}] }`. `canMarkAttendance` is true only while the teacher has an open session and the student hasn't marked yet. |
| `GET /api/student/attendance` | `{ records:[{course, courseCode, session, markedAt, method}] }` |

## Student attendance flow

| Step (frontend page) | Request | Notes |
|---|---|---|
| Dashboard → "Mark Attendance" | `POST /api/attendance/attempts` `{ courseId }` (or `{ sessionCode }`) | → `201 { attemptId, requiredFactors, verified:{ble,qr,face}, session, expiresAt }`. Safe to call again after a refresh; it resumes the same attempt. |
| BleVerification | `POST /api/attendance/attempts/:id/ble` `{ beaconId, rssi }` | `rssi` is negative dBm. Errors: `BLE_BEACON_MISMATCH`, `BLE_TOO_FAR`. |
| (optional) QR scan | `POST /api/attendance/attempts/:id/qr` `{ token }` | `token` is the `token` field from the scanned QR JSON. Errors: `QR_INVALID`, `QR_EXPIRED`. |
| FaceLiveness (start) | `POST /api/attendance/attempts/:id/liveness/challenge` | → `{ challengeId, nonce, actions:["blink","turn_left"], expiresAt }`. Show `actions` to the user. |
| FaceLiveness (result) | `POST /api/attendance/attempts/:id/liveness` `{ challengeId, nonce, passed, score }` | `score` is 0-1. Errors: `LIVENESS_FAILED`, `LIVENESS_CHALLENGE_USED`, `LIVENESS_CHALLENGE_EXPIRED`, `LIVENESS_CHALLENGE_INVALID`, `LIVENESS_TOO_FAST`. Each challenge can be answered once. |
| AttendanceSuccess | `POST /api/attendance/attempts/:id/complete` | → `{ status:"present", markedAt, session, verified }`. Error `VERIFICATION_INCOMPLETE` lists `details.missing`. |
| (anytime) | `GET /api/attendance/attempts/:id` | current progress |

Other codes: `NO_ACTIVE_SESSION` (404), `SESSION_CLOSED` (409), `NOT_ENROLLED` (403),
`ALREADY_MARKED` (409), `ATTEMPT_EXPIRED` (410), `FACTOR_NOT_REQUIRED` (400).

## Teacher

| Method & path | Notes |
|---|---|
| `GET /api/teacher/courses` | their courses + `beaconId` + `activeSessionCode` |
| `POST /api/sessions` | `{ courseId, durationMinutes? = 60, beaconId? }` → `201` session `{ code:"CN301-001", … }`. One open session per course. |
| `GET /api/sessions/:code` | session details |
| `GET /api/sessions/:code/qr` | → `{ sessionId, token, issuedAt, expiresAt, ttlSeconds }`, the **same shape as your existing QR page**. Poll about once a second; the token only changes when it expires. |
| `GET /api/sessions/:code/attendance` | roster: `{ summary:{enrolled,present}, roster:[{studentId,name,present,markedAt,method,bleRssi,faceScore}] }` |
| `PUT /api/sessions/:code/attendance/:studentId` | `{ present: true or false }`. Manual override (e.g. a student's phone has no Bluetooth); recorded as `method:"manual"`. |
| `POST /api/sessions/:code/close` | stop accepting attendance |

`GET /api/health` is public.

---

# Frontend integration (React)

Create `frontend/src/api.js`:

```js
const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
let token = sessionStorage.getItem("token");

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error?.message ?? "Request failed"), { code: data.error?.code });
  return data;
}

export async function login(studentId, password) {
  const data = await api("/api/auth/login", { method: "POST", body: { studentId, password } });
  token = data.token;
  sessionStorage.setItem("token", token);
  return data.user;
}
```

Wiring the existing pages:

```jsx
// Login.jsx - replace the console.log/onLogin with:
try { const user = await login(studentId.trim()); onLogin(user.loginId); }
catch (e) { setError(e.message); }

// Dashboard.jsx - load real classes instead of the hard-coded two
const [data, setData] = useState(null);
useEffect(() => { api("/api/student/dashboard").then(setData); }, []);
// data.summary.overallAttendance, data.classes.map(c => ... c.canMarkAttendance ...)
// onClick: onAttendance(c)   // pass the whole class so you keep c.courseId

// App.jsx - when a class is chosen, create the attempt once and keep its id
const { attemptId } = await api("/api/attendance/attempts", { method: "POST", body: { courseId: c.courseId } });

// BleVerification.jsx - after your real scan returns { beaconId, rssi }
await api(`/api/attendance/attempts/${attemptId}/ble`, { method: "POST", body: { beaconId, rssi } });
onVerified();

// FaceLiveness.jsx - start button
const ch = await api(`/api/attendance/attempts/${attemptId}/liveness/challenge`, { method: "POST" });
// ...show ch.actions to the user, run the liveness model, then:
await api(`/api/attendance/attempts/${attemptId}/liveness`, {
  method: "POST", body: { challengeId: ch.challengeId, nonce: ch.nonce, passed, score },
});
await api(`/api/attendance/attempts/${attemptId}/complete`, { method: "POST" });
onVerified();
```

Until the real BLE/face modules exist, you can send fixed values from the buttons so the whole pipeline
works end to end: BLE `{ beaconId: "BLE-CN301", rssi: -60 }` and liveness `{ passed: true, score: 0.95 }`
(beacon IDs are listed per course in `GET /api/teacher/courses`). The server enforces a minimum response
time (0.8 s) between receiving a challenge and answering it, so don't submit in the same tick.

**Teacher QR page** (`member3-dynamic-qr/frontend/index.html`): delete `generateToken()` and the client-side
`qrPayload`. Instead, log in as the teacher, `POST /api/sessions`, then every second call
`GET /api/sessions/:code/qr` and re-draw the QR only when `token` changes, using the returned JSON as the QR text.
The student scanner then sends `qrData.token` to `/api/attendance/attempts/:id/qr`.
