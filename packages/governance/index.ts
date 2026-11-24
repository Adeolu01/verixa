// Curated public surface of @verixa/governance. Nothing outside this package
// should import from a deep path; see docs/guides/domain-modeling.md
// ("Package encapsulation").

export { ApprovalChain } from "./domain/approval-chain.js";
export type { ApprovalDecision, ApprovalRecord } from "./domain/approval-chain.js";
export {
  ComplianceApprovalRecorded,
  ComplianceCase,
  ComplianceCaseOpened,
  ComplianceCaseTransitioned,
} from "./domain/compliance-case.js";
export type {
  ComplianceCaseId,
  ComplianceCaseProps,
  StateHistoryEntry,
} from "./domain/compliance-case.js";
export {
  WORKFLOW_DEFINITIONS,
  WORKFLOW_TYPES,
  getWorkflowDefinition,
  isWorkflowType,
} from "./domain/workflow-definitions.js";
export type {
  TransitionRule,
  WorkflowDefinition,
  WorkflowType,
} from "./domain/workflow-definitions.js";

export type { ApproverEligibility } from "./application/ports/approver-eligibility.js";
export type {
  ComplianceCaseFilter,
  ComplianceCaseRepository,
} from "./application/ports/compliance-case-repository.js";
export {
  GetComplianceCase,
  ListComplianceCases,
  OpenComplianceCase,
  RecordComplianceApproval,
  TransitionComplianceCase,
} from "./application/use-cases/compliance-case-use-cases.js";

export { InMemoryComplianceCaseRepository } from "./infrastructure/in-memory-compliance-case-repository.js";

export {
  COMPLIANCE_CASE_PERMISSIONS,
  registerComplianceCaseRoutes,
} from "./interface/http/compliance-case-routes.js";
export type {
  ComplianceCaseRouteDependencies,
  PermissionCheck,
} from "./interface/http/compliance-case-routes.js";
