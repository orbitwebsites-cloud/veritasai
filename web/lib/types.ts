/** Shared shapes for the trial pipeline. */

export type Role =
  | "grounding"
  | "decomposer"
  | "prosecution"
  | "expert"
  | "defense"
  | "judge"
  | "citations";

export type StageState = "pending" | "running" | "repairing" | "done" | "failed";

export interface SubClaim {
  id: string;
  text: string;
  why_it_matters: string;
}

export interface Docket {
  domain: string;
  claim_type: string;
  sub_claims: SubClaim[];
  ambiguities: string[];
}

export interface Evidence {
  point: string;
  source: string;
  strength: "strong" | "moderate" | "weak";
}

export interface AdvocateBrief {
  confidence: number;
  headline: string;
  evidence: Evidence[];
  fallacies: string[];
  concessions: string[];
}

export interface ExpertFinding {
  finding: string;
  source: string;
  year: string;
}

export interface ExpertBrief {
  certainty: number;
  consensus: string;
  key_findings: ExpertFinding[];
  open_questions: string[];
  common_misreadings: string[];
}

export type VerdictLabel =
  | "TRUE"
  | "MOSTLY TRUE"
  | "MIXED"
  | "MOSTLY FALSE"
  | "FALSE";

export interface Paper {
  title: string;
  authors: string;
  year: string;
  journal: string;
  doi: string;
  citations: number;
}

export interface WebResult {
  title: string;
  snippet: string;
  url: string;
}

export interface GroundingData {
  papers: Paper[];
  encyclopedia: WebResult[];
  web: WebResult[];
  sources: string[];
  counts: { papers: number; encyclopedia: number; web: number };
}

export type CitationStatus =
  | "verified"
  | "partial"
  | "unverified"
  | "unchecked"
  | "journal_only"
  | "institutional"
  | "unsourced";

export interface SourceCheck {
  source: string;
  party: string;
  status: CitationStatus;
  detail: string;
  matched_title: string;
  doi: string;
  similarity: number;
}

export interface CitationReport {
  checks: SourceCheck[];
  summary: Record<string, Record<string, number>>;
  flagged: number;
  checked: number;
  unchecked: number;
  error?: string;
}

export interface Verdict {
  verdict: VerdictLabel;
  truth_score: number;
  confidence: "High" | "Moderate" | "Low";
  reasoning: string;
  strongest_for: string;
  strongest_against: string;
  nuances: string[];
  recommended_reading: string[];
  briefs: {
    docket: Docket;
    prosecution: AdvocateBrief | null;
    expert: ExpertBrief | null;
    defense: AdvocateBrief | null;
  };
  grounding: (GroundingData & { model: string }) | null;
  citations: CitationReport | null;
}

export interface NodeRecord {
  role: Role;
  model: string;
  provider: string;
  ok: boolean;
  error: string | null;
  latency_s: number;
  repairs: number;
}

export interface Trial {
  claim: string;
  verdict: Verdict;
  nodes: NodeRecord[];
  total_s: number;
}

export interface RosterEntry {
  role: Role;
  label: string;
  provider: string;
  model: string;
}
