"use client";

import { useEffect, useState } from "react";
import { outputFormats, runtimeOptions, voiceOptions } from "@/lib/options";
import type { JobRecord } from "@/lib/types";
import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"] });

type ApiJobResponse = { jobs: JobRecord[] };

type FormState = {
  prompt: string;
  websiteUrl: string;
  outputFormat: (typeof outputFormats)[number]["id"];
  runtime: (typeof runtimeOptions)[number]["id"];
  voiceId: (typeof voiceOptions)[number]["id"];
  ctaCopy: string;
};

const defaultForm: FormState = {
  prompt: "Narrate the PriAi Design workflow for a consulting partner focused on transformation speed.",
  websiteUrl: "https://priai.ai",
  outputFormat: "16:9",
  runtime: "60s",
  voiceId: "aurora",
  ctaCopy: "Book a live PriAi Design working session at priai.ai/demo",
};

const statusCopy: Record<JobRecord["status"], { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "border-white/20 text-white" },
  scraping: { label: "Scraping brand", tone: "border-cyan-200/60 text-cyan-200" },
  prepping: { label: "Prepping assets", tone: "border-sky-200/60 text-sky-100" },
  rendering: { label: "Rendering", tone: "border-indigo-200/60 text-indigo-100" },
  encoding: { label: "Encoding", tone: "border-rose-200/60 text-rose-100" },
  completed: { label: "Completed", tone: "border-emerald-200/80 text-emerald-100" },
  failed: { label: "Failed", tone: "border-red-300/80 text-red-200" },
};

const formatRuntime = (seconds?: number) =>
  seconds ? `${Math.round(seconds)}s` : "";

const parseErrorResponse = async (res: Response) => {
  const fallback = `Request failed (${res.status})`;
  try {
    const text = await res.text();
    if (!text) return fallback;
    try {
      const data = JSON.parse(text) as { error?: string; message?: string };
      if (data?.error) return data.error;
      if (data?.message) return data.message;
      return text;
    } catch {
      return text;
    }
  } catch {
    return fallback;
  }
};

export default function HomePage() {
  const [form, setForm] = useState<FormState>(defaultForm);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedbackNotes, setFeedbackNotes] = useState<Record<string, string>>({});

  const fetchJobs = async () => {
    const res = await fetch("/api/jobs");
    if (!res.ok) return;
    const data = (await res.json()) as ApiJobResponse;
    setJobs(data.jobs);
  };

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 4000);
    return () => clearInterval(interval);
  }, []);

  const submit = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const message = await parseErrorResponse(res);
        throw new Error(message);
      }
      await fetchJobs();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleFeedback = async (jobId: string) => {
    const note = feedbackNotes[jobId];
    if (!note || note.trim().length < 6) return;
    await fetch(`/api/jobs/${jobId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    });
    setFeedbackNotes((prev) => ({ ...prev, [jobId]: "" }));
    fetchJobs();
  };


  return (
    <main className={`min-h-screen bg-[#030712] ${inter.className}`}>
      <div className="mx-auto max-w-6xl px-6 py-12">
        <header className="space-y-4">
          <p className="uppercase tracking-[0.6em] text-sm text-cyan-200/70">PriAi Design · Self-Serve Emulator</p>
          <h1 className="text-4xl md:text-5xl font-semibold text-white leading-tight">
            Spec, launch, and iterate PriAi motion spots without touching the timeline.
          </h1>
          <p className="text-slate-200 text-lg max-w-3xl">
            Feed us a dialogue prompt, brand URL, runtime, and narration voice. We&rsquo;ll scrape styling cues, wire Remotion to
            the right composition, render the cut you need, and keep a live change log for follow-ups.
          </p>
        </header>

        <section className="mt-10 grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-3xl border border-white/10 bg-white/5 backdrop-blur-md p-6 space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-white">Brief the spot</h2>
              {error && <span className="text-sm text-red-300">{error}</span>}
            </div>

            <label className="block space-y-2">
              <span className="text-sm uppercase tracking-[0.3em] text-slate-300">Prompt dialogue</span>
              <textarea
                value={form.prompt}
                onChange={(e) => setForm((prev) => ({ ...prev, prompt: e.target.value }))}
                rows={5}
                className="w-full rounded-2xl border border-white/10 bg-black/30 p-4 text-white outline-none focus:border-cyan-400"
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm uppercase tracking-[0.3em] text-slate-300">Website to scrape (logo, palette, copy)</span>
              <input
                value={form.websiteUrl}
                onChange={(e) => setForm((prev) => ({ ...prev, websiteUrl: e.target.value }))}
                placeholder="https://example.com"
                className="w-full rounded-2xl border border-white/10 bg-black/30 p-4 text-white outline-none focus:border-cyan-400"
              />
            </label>

            <div className="grid gap-6 lg:grid-cols-2">
              <label className="space-y-2">
                <span className="text-sm uppercase tracking-[0.3em] text-slate-300">CTA copy</span>
                <textarea
                  value={form.ctaCopy}
                  onChange={(e) => setForm((prev) => ({ ...prev, ctaCopy: e.target.value }))}
                  rows={3}
                  className="w-full rounded-2xl border border-white/10 bg-black/30 p-4 text-white outline-none focus:border-cyan-400"
                />
                <button
                  type="button"
                  onClick={() =>
                    setForm((prev) => ({
                      ...prev,
                      ctaCopy: "Book a live PriAi Design working session at priai.ai/demo",
                    }))
                  }
                  className="text-xs uppercase tracking-[0.3em] text-cyan-200 hover:text-white"
                >
                  Use suggested CTA
                </button>
              </label>

              <div className="space-y-4">
                <div>
                  <p className="text-sm uppercase tracking-[0.3em] text-slate-300 mb-2">Output format</p>
                  <div className="grid gap-3">
                    {outputFormats.map((format) => (
                      <button
                        key={format.id}
                        onClick={() => setForm((prev) => ({ ...prev, outputFormat: format.id }))}
                        className={`rounded-2xl border px-4 py-3 text-left transition ${
                          form.outputFormat === format.id
                            ? "border-cyan-300 bg-cyan-300/10 text-white"
                            : "border-white/10 text-slate-200"
                        }`}
                      >
                        <p className="font-semibold">{format.label}</p>
                        <p className="text-sm text-slate-300">{format.description}</p>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-sm uppercase tracking-[0.3em] text-slate-300 mb-2">Runtime</p>
                  <div className="flex flex-wrap gap-3">
                    {runtimeOptions.map((option) => (
                      <button
                        key={option.id}
                        onClick={() => setForm((prev) => ({ ...prev, runtime: option.id }))}
                        className={`rounded-full px-4 py-2 text-sm transition border ${
                          form.runtime === option.id
                            ? "border-emerald-300 bg-emerald-300/15 text-white"
                            : "border-white/10 text-slate-200"
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-slate-300 mb-3">Narration voice (royalty free)</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {voiceOptions.map((voice) => (
                  <label
                    key={voice.id}
                    className={`rounded-2xl border p-4 cursor-pointer transition ${
                      form.voiceId === voice.id
                        ? "border-amber-300 bg-amber-200/10 text-white"
                        : "border-white/10 text-slate-200"
                    }`}
                  >
                    <input
                      type="radio"
                      className="hidden"
                      checked={form.voiceId === voice.id}
                      onChange={() => setForm((prev) => ({ ...prev, voiceId: voice.id }))}
                    />
                    <p className="font-semibold">{voice.label}</p>
                    <p className="text-sm text-slate-300">{voice.description}</p>
                  </label>
                ))}
              </div>
            </div>

            <button
              onClick={submit}
              disabled={loading}
              className="w-full rounded-2xl bg-gradient-to-r from-cyan-400 to-indigo-500 py-4 text-lg font-semibold text-black shadow-lg shadow-cyan-500/30 disabled:opacity-40"
            >
              {loading ? "Submitting…" : "Generate video brief"}
            </button>
          </div>

          <div className="space-y-6">
            <div className="rounded-3xl border border-white/10 bg-black/30 backdrop-blur p-6">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-white">Live queue</h2>
                <span className="text-sm text-slate-400">{jobs.length} requests</span>
              </div>
              <div className="mt-4 space-y-4 max-h-[560px] overflow-y-auto pr-2">
                {jobs.map((job) => (
                  <article key={job.id} className="rounded-2xl border border-white/10 bg-white/5 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-white font-semibold">{job.payload.outputFormat} · {job.payload.runtime}</p>
                        <p className="text-xs text-slate-300">{new Date(job.createdAt).toLocaleString()}</p>
                      </div>
                      <span className={`rounded-full border px-3 py-1 text-xs uppercase tracking-wide ${statusCopy[job.status].tone}`}>
                        {statusCopy[job.status].label}
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-white/5">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-indigo-400"
                        style={{ width: `${Math.round(job.progress * 100)}%` }}
                      />
                    </div>
                    <p className="text-sm text-slate-200 line-clamp-2">{job.payload.prompt}</p>
                    {job.result && (
                      <div className="space-y-2">
                        <video
                          src={`/api/jobs/${job.id}/asset`}
                          controls
                          className="w-full rounded-xl border border-white/10"
                        />
                        <p className="text-xs text-slate-400">
                          {job.result.composition} · {formatRuntime(job.result.runtimeSeconds)}
                        </p>
                      </div>
                    )}
                    {job.status === "failed" && job.error && (
                      <p className="text-sm text-red-300">{job.error}</p>
                    )}
                    {job.status === "completed" && (
                      <div className="space-y-2">
                        <textarea
                          placeholder="Request tweaks, e.g. ‘Tighten CTA timing’"
                          value={feedbackNotes[job.id] ?? ""}
                          onChange={(e) => setFeedbackNotes((prev) => ({ ...prev, [job.id]: e.target.value }))}
                          className="w-full rounded-xl border border-white/10 bg-black/40 p-2 text-sm text-white"
                        />
                        <button
                          onClick={() => handleFeedback(job.id)}
                          className="text-xs uppercase tracking-[0.3em] text-emerald-200 hover:text-white"
                        >
                          Send change request
                        </button>
                      </div>
                    )}
                    <details className="text-xs text-slate-400">
                      <summary className="cursor-pointer text-slate-200">Production log</summary>
                      <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed">
                        {job.logs.join("\n")}
                      </div>
                    </details>
                  </article>
                ))}
                {jobs.length === 0 && <p className="text-sm text-slate-400">No jobs yet. Submit the brief to start.</p>}
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
