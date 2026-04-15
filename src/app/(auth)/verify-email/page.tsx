"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function VerifyEmailPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId");
  const email = searchParams.get("email");
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  function handleChange(index: number, value: string) {
    if (!/^\d*$/.test(value)) return;
    const newOtp = [...otp];
    newOtp[index] = value.slice(-1);
    setOtp(newOtp);
    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    const newOtp = [...otp];
    for (let i = 0; i < pasted.length; i++) {
      newOtp[i] = pasted[i];
    }
    setOtp(newOtp);
    inputRefs.current[Math.min(pasted.length, 5)]?.focus();
  }

  async function handleVerify() {
    const code = otp.join("");
    if (code.length !== 6) {
      setError("Please enter the full 6-digit code");
      return;
    }
    setError("");
    setLoading(true);

    const res = await fetch("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, otp: code }),
    });
    const data = await res.json();

    if (!res.ok) {
      setError(data.error || "Verification failed");
      setLoading(false);
      return;
    }

    router.push("/onboarding");
    router.refresh();
  }

  async function handleResend() {
    setResending(true);
    setResent(false);
    await fetch("/api/auth/send-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, userId }),
    });
    setResending(false);
    setResent(true);
    setTimeout(() => setResent(false), 5000);
  }

  if (!userId || !email) {
    return (
      <div className="flex flex-col gap-4 items-center">
        <p className="text-sm text-muted-foreground">Invalid verification link.</p>
        <Link href="/signup" className="text-sm font-medium underline">Go to signup</Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Check your email</h1>
        <p className="text-sm text-muted-foreground">
          We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>
        </p>
      </div>

      <div className="flex gap-2 justify-center" onPaste={handlePaste}>
        {otp.map((digit, i) => (
          <Input
            key={i}
            ref={(el) => { inputRefs.current[i] = el }}
            value={digit}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            maxLength={1}
            className="h-14 w-12 rounded-xl text-center text-xl font-semibold"
            inputMode="numeric"
          />
        ))}
      </div>

      {error && <p className="text-sm text-red-600 text-center">{error}</p>}

      <Button
        onClick={handleVerify}
        disabled={loading || otp.join("").length !== 6}
        className="h-11 w-full rounded-xl bg-black text-white hover:bg-black/90"
      >
        {loading ? "Verifying..." : "Verify Email"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        Didn&apos;t receive the code?{" "}
        <button
          onClick={handleResend}
          disabled={resending}
          className="font-medium text-foreground underline underline-offset-4 hover:text-foreground/80"
        >
          {resending ? "Sending..." : resent ? "Sent!" : "Resend"}
        </button>
      </p>

      <Link
        href="/login"
        className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to login
      </Link>
    </div>
  );
}
