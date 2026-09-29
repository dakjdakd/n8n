/** Causes the workflow list can filter on with `filter.wontExecute`. */
export const WORKFLOW_WONT_EXECUTE_CAUSES = ['restrictedNode'] as const;

export type WorkflowWontExecuteCause = (typeof WORKFLOW_WONT_EXECUTE_CAUSES)[number];
