"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createBrowserClient } from "@supabase/ssr";

const industries = [
  "Technology",
  "Healthcare",
  "Finance",
  "Education",
  "Retail",
  "Manufacturing",
  "Real Estate",
  "Media",
  "Hospitality",
  "Other",
];

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [orgName, setOrgName] = useState("");
  const [industry, setIndustry] = useState("");
  const [saving, setSaving] = useState(false);
  const [orgId, setOrgId] = useState<string | null>(null);

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  useEffect(() => {
    async function loadOrg() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }

      const { data: membership } = await supabase
        .from("org_members")
        .select("org_id, organizations(id, name, industry)")
        .eq("user_id", user.id)
        .single();

      if (membership) {
        setOrgId(membership.org_id);
        const org = membership.organizations as unknown as {
          id: string;
          name: string;
          industry: string | null;
        };
        if (org) {
          setOrgName(org.name || "");
          setIndustry(org.industry || "");
        }
      }
    }
    loadOrg();
  }, []);

  async function handleSaveOrg() {
    if (!orgId) return;
    setSaving(true);
    await supabase
      .from("organizations")
      .update({ name: orgName, industry })
      .eq("id", orgId);
    setSaving(false);
    setStep(2);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f5f5f5] p-4">
      <div className="w-full max-w-lg">
        {/* Progress */}
        <div className="mb-8 flex items-center gap-2">
          {[1, 2, 3].map((s) => (
            <div
              key={s}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                s <= step ? "bg-[#0a0a0a]" : "bg-[#e0e0e0]"
              }`}
            />
          ))}
        </div>

        {step === 1 && (
          <Card className="border-[#ebebeb]">
            <CardHeader>
              <CardTitle className="text-xl">Set up your organization</CardTitle>
              <CardDescription>
                Tell us about your company so we can customize your experience.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="orgName">Organization name</Label>
                <Input
                  id="orgName"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="Acme Inc."
                  className="h-11 rounded-xl"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="industry">Industry</Label>
                <Select value={industry} onValueChange={(v) => v && setIndustry(v)}>
                  <SelectTrigger className="h-11 rounded-xl">
                    <SelectValue placeholder="Select an industry" />
                  </SelectTrigger>
                  <SelectContent>
                    {industries.map((ind) => (
                      <SelectItem key={ind} value={ind.toLowerCase()}>
                        {ind}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={handleSaveOrg}
                disabled={!orgName || saving}
                className="h-11 w-full rounded-xl bg-black text-white hover:bg-black/90"
              >
                {saving ? "Saving..." : "Continue"}
              </Button>
            </CardContent>
          </Card>
        )}

        {step === 2 && (
          <Card className="border-[#ebebeb]">
            <CardHeader>
              <CardTitle className="text-xl">Create your first agent</CardTitle>
              <CardDescription>
                Agents handle customer conversations across your channels.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Button
                onClick={() => router.push("/agents/new")}
                className="h-11 w-full rounded-xl bg-black text-white hover:bg-black/90"
              >
                Create an agent
              </Button>
              <Button
                variant="outline"
                onClick={() => setStep(3)}
                className="h-11 w-full rounded-xl"
              >
                Skip for now
              </Button>
            </CardContent>
          </Card>
        )}

        {step === 3 && (
          <Card className="border-[#ebebeb]">
            <CardHeader>
              <CardTitle className="text-xl">You&apos;re all set!</CardTitle>
              <CardDescription>
                Your workspace is ready. Head to the dashboard to get started.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={() => router.push("/dashboard")}
                className="h-11 w-full rounded-xl bg-black text-white hover:bg-black/90"
              >
                Go to dashboard
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
