import type { RestrictedNodeTypes } from '@n8n/db';
import { Service } from '@n8n/di';

export const NO_RESTRICTED_NODE_TYPES: RestrictedNodeTypes = {
	shared: [],
	exceptProjectIds: [],
	byProjects: [],
};

/**
 * Lets the policies module tell the workflow list which node types it restricts, without core
 * depending on the module. With no provider registered, no node type is restricted.
 */
export interface RestrictedNodeTypesProvider {
	/** The node types in use that a policy denies, by the owner project a workflow is judged in. */
	findRestrictedNodeTypesInUse(): Promise<RestrictedNodeTypes>;
}

@Service()
export class RestrictedNodeTypesProviderProxy implements RestrictedNodeTypesProvider {
	private provider: RestrictedNodeTypesProvider | null = null;

	registerProvider(provider: RestrictedNodeTypesProvider): void {
		this.provider = provider;
	}

	async findRestrictedNodeTypesInUse(): Promise<RestrictedNodeTypes> {
		return (await this.provider?.findRestrictedNodeTypesInUse()) ?? NO_RESTRICTED_NODE_TYPES;
	}
}
