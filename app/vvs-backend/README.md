# VVS Dost Minimal Backend

This is the new small backend for VVS Dost.

It is intentionally separate from the older Sakhi-derived backend.

## What it does

- accepts a student message at `POST /api/chat`
- optionally accepts lightweight memory from the app
- calls Gemini on the server
- returns `{ "reply": "..." }`

## Environment variables

Copy `.env.example` to `.env` and set:

- `GEMINI_API_KEY`
- `APP_TOKEN`
- `PORT` (optional)

## Local run

```bash
npm install
npm start
```

Health check:

```bash
GET /health
```

Chat endpoint:

```bash
POST /api/chat
Content-Type: application/json
x-app-token: YOUR_APP_TOKEN

{
  "message": "I felt left out in class today.",
  "memory": [
    "The student felt nervous before a presentation.",
    "They had a fight with a friend last week."
  ]
}
```

## Fast Render deploy

Use this folder as the Render service root:

- Root directory: `app/vvs-backend`
- Build command: `npm install`
- Start command: `npm start`

Set these environment variables in Render:

- `GEMINI_API_KEY`
- `APP_TOKEN`

Then point the app to:

```text
https://YOUR-RENDER-SERVICE.onrender.com/api/chat
```
