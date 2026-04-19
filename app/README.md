# Sakhi AI

Sakhi AI is an MIT App Inventor project with a protected Gemini-backed reflection service.

This repository includes:

- `Sakhi.aia`: the current App Inventor project
- `sakhi_edit/`: extracted App Inventor screen source for editing and version control
- `server.js`: Node/Express middleware that hides the Gemini API key and retrieves anonymized Maitri peer excerpts
- `public/`: a small browser test client for the backend
- `appinventor/README.md`: notes for wiring the App Inventor client to the backend

## App flow

- `Screen1`: welcome screen
- `StageScreen`: stage selection
- `ConcernScreen`: reflective prompt and AI response
- `Screen2`: about and safeguards

## Backend

The app calls a backend in the middle rather than exposing the model key in App Inventor.

Environment variables:

- `GEMINI_API_KEY`
- `GEMINI_MODEL`
- `APP_ACCESS_TOKEN`
- `ALLOWED_ORIGIN`
- `CUSTOM_GPT_INSTRUCTIONS`
- `SCHOOL_RESPONSES_CSV`
- `COLLEGE_RESPONSES_CSV`
- `WORKING_WOMEN_RESPONSES_CSV`
- `SCHOLARSHIP_RESPONSES_CSV`
- `INTERNSHIP_RESPONSES_CSV`

## Local setup

1. Copy `.env.example` to `.env`
2. Run `npm install`
3. Run `npm start`

## Notes

- The App Inventor project still contains a placeholder backend URL and should be updated to the deployed backend endpoint.
- `node_modules/` is intentionally excluded from version control.
- Raw Maitri CSVs should stay server-side and should not be committed to a public repository because they contain personal data.
