"use client";

import { useCallback, useEffect, useState } from "react";

interface JobRow {
  id: string;
  name: string;
  model: string;
  mode: string;
  state: string;
  total_residues: number;
  attempts: number;
  error_message: string | null;
  mean_plddt: number | null;
  created_at: string;
}

const EXAMPLE = `>ubiquitin
MQIFVKTLTGKTITLEVEPSDTIENVKAKIQDKEGIPPDQQRLIFAGKQLEDGRTLSDYNIQKESTLHLVLRLRGG`;

/** Phase 0 scaffold: submit and watch the queue. The real submit and triage screens come later. */
export function JobsView() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [fasta, setFasta] = useState(EXAMPLE);
  const [problems, setProblems] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/jobs");
    setJobs((await res.json()).jobs);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/jobs", { method: "POST", body: JSON.stringify({ fasta }) });
    if (res.status === 422) {
      const body = await res.json();
      setProblems(body.problems.map((p: { record: string; message: string }) => `${p.record}: ${p.message}`));
      return;
    }
    setProblems([]);
    refresh();
  }

  return (
    <>
      <form onSubmit={submit}>
        <label htmlFor="fasta"><h2>Sequences (FASTA)</h2></label>
        <textarea id="fasta" rows={8} value={fasta} onChange={(e) => setFasta(e.target.value)} />
        {problems.map((p) => <p key={p} className="error">{p}</p>)}
        <button type="submit">Fold</button>
      </form>
      <h2>Jobs</h2>
      <table>
        <thead>
          <tr><th>Name</th><th>State</th><th>Model</th><th>Residues</th><th>Mean pLDDT</th></tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td><a href={`/jobs/${j.id}`}>{j.name}</a></td>
              <td>{j.state}{j.attempts > 1 ? ` (attempt ${j.attempts})` : ""}</td>
              <td>{j.model}</td>
              <td>{j.total_residues}</td>
              <td>{j.mean_plddt?.toFixed(1) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
