# G2-mail

Gmail reader for [Even Realities G2](https://www.evenrealities.com/) smart glasses.

Browse Gmail labels, navigate email lists, and read full emails as paginated plain text — all from your glasses. A companion phone UI lets you sign in with Google, pick labels, and see connection status.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- A Google Cloud project with the **Gmail API** enabled and an **OAuth 2.0 Client ID**

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/r-castelo/G2-Gmail.git
cd G2-Gmail
npm install
```

### 2. Create your Google OAuth credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Navigate to **APIs & Services > Library** and enable the **Gmail API**
4. Go to **APIs & Services > Credentials** and click **Create Credentials > OAuth client ID**
5. Choose **Web application** as the application type
6. Under **Authorized redirect URIs**, add:
   - `http://localhost:5173/` (for local development)
   - `https://<your-github-username>.github.io/G2-Gmail/` (if deploying to GitHub Pages)
7. Copy the **Client ID** and **Client Secret**

### 3. Configure your `.env` file

Copy the example file and fill in your credentials:

```bash
cp .env.example .env
```

Then edit `.env`:

```
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
VITE_GOOGLE_CLIENT_SECRET=your-client-secret
```

> **Note:** The `.env` file is git-ignored and will never be committed.

## Development

Start the Vite dev server:

```bash
npm run dev
```

This serves the app at `http://localhost:5173/`. Open it on your phone browser to see the phone companion UI, then connect your G2 glasses.

### Useful commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start local dev server |
| `npm run build` | Type-check and build for production |
| `npm run preview` | Preview the production build locally |
| `npm run typecheck` | Run TypeScript type checking only |
| `npm run test` | Run unit tests |
| `npm run sim` | Launch the EvenHub glasses simulator |
| `npm run qr` | Generate a QR code to load the app on glasses |
| `npm run pack` | Build and package as `.ehpk` for deployment |

## How it works

1. **Phone UI** — Sign in with Google OAuth. The phone shows your Gmail labels and connection status.
2. **Tap a label** — The glasses navigate to that label's message list; the phone highlights the selected label.
3. **Glasses navigation** — Scroll through messages, tap to open, scroll to page through the email body. Double-tap to go back.

### Glasses gesture controls

| Gesture | Labels view | Message list | Reader |
| --- | --- | --- | --- |
| Scroll | Navigate list | Navigate list | Next/prev page |
| Tap | Open label | Open message | Back to list |
| Double-tap | — | Back to labels | Back to list |

## Project structure

```
src/
  adapters/     # Glass and Gmail API adapters
  app/          # Controller and state machine
  config/       # Constants and Gmail OAuth config
  domain/       # HTML-to-text conversion, pagination
  phone/        # Phone companion UI (React)
  services/     # Auth and wake-lock services
  types/        # TypeScript contracts/interfaces
  main.ts       # App entry point
```

## Deployment (GitHub Pages)

The repo includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that builds and deploys to GitHub Pages on every push to `main`.

**One-time setup:**

1. Go to your GitHub repo → **Settings → Secrets and variables → Actions**
2. Add repository secrets: `VITE_GOOGLE_CLIENT_ID` and `VITE_GOOGLE_CLIENT_SECRET`
3. Go to **Settings → Pages → Source** and select **GitHub Actions**
4. Push to `main` — the workflow builds and deploys automatically

## Security notes

- OAuth credentials are loaded from `VITE_GOOGLE_CLIENT_ID` and `VITE_GOOGLE_CLIENT_SECRET` environment variables at build time
- The client secret for Google "Web application" OAuth clients is not truly secret — Google relies on redirect-URI validation and PKCE for security
- The `.env` file is excluded from version control via `.gitignore`
- Only `.env.example` (with placeholder values) is committed
- Refresh tokens are stored in the browser's `localStorage`; access tokens are kept in memory only
- The requested scope is `gmail.modify` (read + mark as read)

## License

This project is provided as-is for personal use.
