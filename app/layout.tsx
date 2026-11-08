import type { Metadata, Viewport } from "next";
import "./globals.css";
import PwaBoot from "@/components/PwaBoot";

export const metadata: Metadata = {
  title: "Brian — AI voice assistant",
  description:
    "Talk to your phone naturally. Brian listens for your wake word, answers out loud and handles calls, alarms, apps and reminders.",
  applicationName: "Brian",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Brian",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icon-192.png", sizes: "192x192" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#05060c",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <PwaBoot />
      </body>
    </html>
  );
}
