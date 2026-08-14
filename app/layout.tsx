import type { Metadata, Viewport } from "next";
import { warnIfEmailDisabled } from "@/lib/env";
import "./globals.css";

// Runs once per server instance at module load.
warnIfEmailDisabled();

export const metadata: Metadata = {
  title: "Discover your Leader Archetype",
  description: "A three-minute quiz that reveals how you lead, and how your team leads with you.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
  // Ask the browser to shrink the layout viewport when the soft keyboard opens, rather than
  // letting the keyboard sit over the page. Chrome on Android honours this; iOS Safari does
  // not, which is why InterviewChat also measures the overlap via visualViewport.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-AU">
      <body>{children}</body>
    </html>
  );
}
