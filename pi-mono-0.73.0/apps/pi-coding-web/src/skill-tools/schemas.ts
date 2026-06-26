import type {
	SkillListResult,
	SkillLoadResult,
	SkillResourceResult,
	SkillInterfaceMetadata as WorkspaceSkillInterfaceMetadata,
	SkillResourceSummary as WorkspaceSkillResourceSummary,
	SkillSummary as WorkspaceSkillSummary,
} from "@mariozechner/pi-web-workspace";

export type SkillSummary = WorkspaceSkillSummary;

export type SkillInterfaceMetadata = WorkspaceSkillInterfaceMetadata;

export type SkillResourceSummary = WorkspaceSkillResourceSummary;

export type SkillListDetails = SkillListResult;

export type SkillLoadDetails = SkillLoadResult;

export type SkillResourceDetails = SkillResourceResult;

export type { SkillLoadParams, SkillResourceParams } from "@mariozechner/pi-web-workspace/skill-tool-contract";
export {
	formatSkillLoadResult,
	prepareSkillLoadArguments,
	prepareSkillResourceArguments,
	skillLoadSchema,
	skillResourceSchema,
} from "@mariozechner/pi-web-workspace/skill-tool-contract";
