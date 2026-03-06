# Job Application Intelligence Tracker

AI-powered job search copilot that helps users optimize each application before applying, then track outcomes through a structured pipeline.

## Overview

Most job trackers only store statuses. This app combines tracking + role-specific intelligence:

- Per-application resume upload and JD analysis
- Fit score, skill-gap insights, and tailored bullets
- Apply decision engine: `Apply now`, `Improve then apply`, `Skip for now`
- Stage-aware progression after applying (`Already applied`, `In process`, etc.)
- Weekly strategy insight from recent activity

## Key Features

- Authentication:
  - Google sign-in
  - Email/password sign-up and sign-in
- Application pipeline:
  - `Saved`, `Applied`, `OA`, `Interview`, `Offer`, `Rejected`
- Resume + JD intelligence:
  - Upload resume per application (`pdf`, `docx`, `txt`, `md`)
  - Extract resume text for analysis
  - Analyze resume against JD
- Strategy layer:
  - Decision + reason + actionable plan
  - Decision/status filters for prioritization
- UX:
  - Route-based detail page (`/applications/:applicationId`)
  - Search, filter, sort
  - Form validation and inline missing-field feedback

## Tech Stack

- Frontend: React + Vite
- Routing: React Router
- Backend services: Firebase
  - Authentication
  - Firestore
  - Cloud Storage
  - Cloud Functions
- AI: OpenAI (with local heuristic fallback)

## Project Structure

```text
job-intelligence-tracker/
  src/
    App.jsx
    firebase.js
  functions/
    index.js
  firestore.rules
  storage.rules
  firebase.json
```

## Data Model (Firestore)

- `users/{uid}`
  - `name`, `email`, `createdAt`, `updatedAt`
- `users/{uid}/applications/{appId}`
  - metadata: `company`, `role`, `stage`, `appliedDate`, `jobUrl`, `notes`
  - resume/jd: `resumeText`, `resumeFileName`, `resumeFileUrl`, `jdText`
  - analysis: `fitScore`, `missingSkills`, `suggestedBullets`, `fitExplanation`
  - strategy: `decision`, `reason`, `actionPlan`
  - stability: `analysisInputSignature`

## Deterministic Analysis Behavior

To prevent inconsistent output for unchanged inputs:

- app computes an `analysisInputSignature` from role/company/resume/jd
- re-analysis is skipped when input signature is unchanged
- cloud analysis uses deterministic settings (`temperature: 0`, seeded request)

## Prerequisites

- Node.js 20.19+ or 22+
- Firebase CLI installed and logged in
- Firebase project with:
  - Auth enabled (Google + Email/Password)
  - Firestore created
  - Storage bucket created
  - Functions enabled (Blaze plan may be required)

## Environment Setup

### 1) Frontend env

Create `.env` in project root:

```env
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
```

### 2) Functions env (optional but recommended)

Create `functions/.env`:

```env
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
```

If `OPENAI_API_KEY` is not provided, the app uses local heuristic fallback.

## Installation

```bash
npm install
cd functions && npm install && cd ..
```

## Run Locally

```bash
npm run dev
```

Production preview:

```bash
npm run build
npm run preview
```

## Firebase Deploy

Deploy rules, functions, and hosting:

```bash
firebase deploy --only firestore:rules,storage,functions,hosting
```

## Usage Flow

1. Sign in
2. Add application in `Saved` or `Applied`
3. Upload resume + paste JD
4. Run analysis
5. Review decision/action plan
6. Update stage and track outcomes

## Limitations

- Resume extraction quality depends on source file formatting
- Large parser libraries increase bundle size
- Weekly insight is heuristic, not full predictive ML

## Future Improvements

- Resume version history per role
- Export report (PDF/CSV)
- Follow-up automation
- Team/recruiter collaboration view

## License

This project is for portfolio/demo use.
