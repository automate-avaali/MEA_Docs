import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

/** Coral tile with a document + magnifier mark (same palette as the app). */
export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ width: 64, height: 64, borderRadius: 14, background: "#d4643a", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4" />
          <path d="M14 3v5h5" />
          <path d="M19 8v3" />
          <circle cx="16.5" cy="16.5" r="3" />
          <path d="m21 21-2.4-2.4" />
        </svg>
      </div>
    ),
    size,
  );
}
