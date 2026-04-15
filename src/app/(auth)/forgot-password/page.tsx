"use client";

import { useState, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "otp" | "newpass" | "done">("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  async function handleSendCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const res = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "Failed to send code");
    } else {
      setStep("otp");
    }
    setLoading(false);
  }

  function handleOtpChange(index: number, value: string) {
    if (!/^\d*$/.test(value)) return;
    const newOtp = [...otp];
    newOtp[index] = value.slice(-1);
    setOtp(newOtp);
    if (value && index < 5) inputRefs.current[index + 1]?.focus();
  }

  function handleOtpKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }

  function handleOtpPaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    const newOtp = [...otp];
    for (let i = 0; i < pasted.length; i++) newOtp[i] = pasted[i];
    setOtp(newOtp);
  }

  function handleVerifyOtp() {
    if (otp.join("").length !== 6) {
      setError("Enter the full 6-digit code");
      return;
    }
    setError("");
    setStep("newpass");
  }

  async function handleResetPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp: otp.join(""), newPassword }),
    });
    const data = await res.json();

    if (!res.ok) {
      setError(data.error || "Failed to reset password");
      if (data.error?.includes("expired") || data.error?.includes("Invalid")) {
        setStep("otp");
      }
      setLoading(false);
      return;
    }

    setStep("done");
    setLoading(false);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {step === "done" ? "Password reset" : "Reset your password"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {step === "email" && "Enter your email and we'll send you a code."}
          {step === "otp" && `We sent a 6-digit code to ${email}`}
          {step === "newpass" && "Enter your new password."}
          {step === "done" && "Your password has been updated."}
        </p>
      </div>

      {step === "email" && (
        <form onSubmit={handleSendCode} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
              className="h-11 rounded-xl"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" disabled={loading} className="h-11 w-full rounded-xl bg-black text-white hover:bg-black/90">
            {loading ? "Sending..." : "Send reset code"}
          </Button>
        </form>
      )}

      {step === "otp" && (
        <div className="flex flex-col gap-4">
          <div className="flex gap-2 justify-center" onPaste={handleOtpPaste}>
            {otp.map((digit, i) => (
              <Input
                key={i}
                ref={(el) => { inputRefs.current[i] = el }}
                value={digit}
                onChange={e => handleOtpChange(i, e.target.value)}
                onKeyDown={e => handleOtpKeyDown(i, e)}
                maxLength={1}
                className="h-14 w-12 rounded-xl text-center text-xl font-semibold"
                inputMode="numeric"
              />
            ))}
          </div>
          {error && <p className="text-sm text-red-600 text-center">{error}</p>}
          <Button onClick={handleVerifyOtp} disabled={otp.join("").length !== 6} className="h-11 w-full rounded-xl bg-black text-white hover:bg-black/90">
            Verify Code
          </Button>
        </div>
      )}

      {step === "newpass" && (
        <form onSubmit={handleResetPassword} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="newPassword">New password</Label>
            <div className="relative">
              <Input
                id="newPassword"
                type={showPassword ? "text" : "password"}
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="Enter new password"
                required
                minLength={6}
                className="h-11 rounded-xl pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" disabled={loading} className="h-11 w-full rounded-xl bg-black text-white hover:bg-black/90">
            {loading ? "Resetting..." : "Reset password"}
          </Button>
        </form>
      )}

      {step === "done" && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          Your password has been updated. You can now sign in with your new password.
          <Button onClick={() => router.push("/login")} className="mt-4 h-11 w-full rounded-xl bg-black text-white hover:bg-black/90">
            Go to login
          </Button>
        </div>
      )}

      {step !== "done" && (
        <Link href="/login" className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" />
          Back to login
        </Link>
      )}
    </div>
  );
}
