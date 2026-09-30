/**
 * FASTA parsing and validation.
 *
 * Complexes use the ColabFold convention: chains in one record separated by
 * ':' (e.g. `>my_dimer` then `MKT...:MQI...`).
 */

export interface FastaRecord {
  name: string;
  chains: string[];
}

export interface FastaProblem {
  record: string;
  message: string;
}

export const AMINO_ACIDS = "ACDEFGHIKLMNPQRSTVWY";
const VALID = new RegExp(`^[${AMINO_ACIDS}]+$`);

export function parseFasta(text: string): { records: FastaRecord[]; problems: FastaProblem[] } {
  const records: FastaRecord[] = [];
  const problems: FastaProblem[] = [];
  let name: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (name === null) return;
    const seq = body.join("").replace(/\s+/g, "").toUpperCase().replace(/\*$/, "");
    const chains = seq.split(":").filter(Boolean);
    if (chains.length === 0) problems.push({ record: name, message: "has no sequence." });
    chains.forEach((chain, i) => {
      if (!VALID.test(chain)) {
        const bad = [...new Set(chain.replace(new RegExp(`[${AMINO_ACIDS}]`, "g"), ""))].join(", ");
        const where = chains.length > 1 ? `Chain ${i + 1}` : "Sequence";
        problems.push({ record: name!, message: `${where} contains characters that aren't amino acids: ${bad}` });
      }
    });
    records.push({ name, chains });
  };

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith(">")) {
      flush();
      name = line.slice(1).trim() || `sequence_${records.length + 1}`;
      body = [];
    } else if (line.trim()) {
      if (name === null) name = "sequence_1"; // a bare sequence with no header
      body.push(line);
    }
  }
  flush();
  return { records, problems };
}
