import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Jordon — AI Chatbots & Voice Agents",
  description:
    "Build and deploy AI chatbots and voice agents for your business. Automate customer support, lead capture, and more with Jordon.",
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} h-full antialiased`}>
      <body
        className="min-h-full flex flex-col font-[var(--font-inter)]"
      >
        {children}
        <Toaster position="top-right" richColors />
      </body>
    </html>
  );
}
