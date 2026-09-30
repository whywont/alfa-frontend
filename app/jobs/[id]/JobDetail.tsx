"use client";

import { useEffect, useState } from "react";

interface Detail {
  job: { id: string; name: string; state: string; model: string; error_message: string | null; mean_plddt: number | null };
  attempts: { id: string; attempt_no: number; backend: string; state: string; error_message: string | null }[];
  events: { at: string; to_state: string; reason: string }[];
  logs: { at: string; line: string }[];
  artifacts: { id: string; name: string; kind: string; bytes: number }[];
}

/** Phase 0 scaffold: history, logs, and downloads. The viewer and PAE come in phase 3. */
export function JobDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);

  useEffect(() => {
    const load = async () => {
      const res = await fetch(`/api/jobs/${id}`);
      if (res.ok) setDetail(await res.json());
    };
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [id]);

  if (!detail) return <p className="muted">Loading…</p>;
  const { job } = detail;
  const cancellable = job.state === "queued" || job.state === "running";

  return (
    <>
      <h1>{job.name}</h1>
      <p>
        {job.state} · {job.model}
        {job.mean_plddt != null && ` · mean pLDDT ${job.mean_plddt.toFixed(1)}`}
      </p>
      {job.error_message && <p className="error">{job.error_message}</p>}
      {cancellable && (
        <button type="button" onClick={() => fetch(`/api/jobs/${id}/cancel`, { method: "POST" })}>Cancel</button>
      )}
      <h2>Files</h2>
      <ul>
        {detail.artifacts.map((a) => (
          <li key={a.id}><a href={`/api/artifacts/${a.id}`}>{a.name}</a> <span className="muted">{a.kind}, {a.bytes} bytes</span></li>
        ))}
      </ul>
      <h2>History</h2>
      <ul>
        {detail.events.map((e) => (
          <li key={`${e.at}-${e.to_state}`}>{new Date(e.at).toLocaleString()} — {e.reason}</li>
        ))}
      </ul>
      <h2>Log</h2>
      <pre className="log">{detail.logs.map((l) => l.line).join("\n") || "No output yet."}</pre>
    </>
  );
}
