/** 工作区检查点占位类型；Moros Harness 使用 core 快照回滚，不提供 /undo 数据源。 */
export interface CheckpointEntry {
	readonly id: string;
	readonly turn: number;
	readonly createdAt: number;
	readonly kind: "turn" | "safety";
	readonly label: string;
	readonly changes?: number;
}
export interface CheckpointPreview {
	readonly entry: CheckpointEntry;
	readonly changes: readonly { readonly path: string; readonly status: string }[];
}
export interface CheckpointRestoreResult {
	readonly entry: CheckpointEntry;
	readonly restored: number;
	readonly removed: number;
	readonly safety: CheckpointEntry;
}
