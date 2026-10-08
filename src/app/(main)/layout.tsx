import type { Metadata } from "next";
import "./globals.css";
import AppShell from "@/components/AppShell";

export const metadata: Metadata = {
  title: "DockFlow Console — Docker Desktop + workflow + APM",
  description:
    "Hierarchical xyflow maps over the local Docker Engine API, workflow automation and pinpoint-style APM service maps.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
