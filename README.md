# mail-sherlock
email-assistant/
│
├── backend/                        # Python FastAPI server
│   ├── main.py                     # FastAPI app + /ask endpoint
│   ├── embeddings.py               # Load model, encode emails
│   ├── emails.json                 # Mock email dataset
│   └── requirements.txt            # fastapi, uvicorn, sentence-transformers, torch
│
├── extension/                      # Chrome Extension (React + Vite)
│   ├── public/
│   │   └── manifest.json           # Chrome extension config (MV3)
│   │
│   ├── src/
│   │   ├── popup/
│   │   │   ├── App.tsx             # Main chat UI component
│   │   │   ├── ResultCard.tsx      # Single email result card
│   │   │   └── popup.html          # Entry HTML for popup
│   │   │
│   │   ├── api/
│   │   │   └── search.ts           # fetch() wrapper for /ask endpoint
│   │   │
│   │   └── main.tsx                # React entry point
│   │
│   ├── package.json
│   ├── vite.config.ts              # Vite build → dist/
│   └── tsconfig.json
│
├── dist/                           # Built extension (load this in Chrome)
│   ├── popup.html
│   ├── popup.js
│   └── manifest.json
│
└── README.md