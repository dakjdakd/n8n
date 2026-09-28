import type { AgentJsonConfig } from '@n8n/api-types';
import type { PolicyViolation } from '@n8n/decorators';
import { mock } from 'vitest-mock-extended';

import type { PolicyEnforcementBackend } from '@/policy/policy-enforcement-backend';
import { PolicyEnforcementService } from '@/policy/policy-enforcement.service';
import { PolicyViolationError } from '@/policy/policy-violation.error';

import { AgentPolicyService } from '../agent-policy.service';

const dateTimeTool = {
	type: 'node',
	name: 'Current date',
	node: { nodeType: 'n8n-nodes-base.dateTime', nodeTypeVersion: 2, nodeParameters: {} },
} as const;

const agent = (tools: AgentJsonConfig['tools']) => ({ name: 'Support agent', tools });

const violation: PolicyViolation = {
	kind: 'node-type-unavailable',
	checkId: 'node-type-availability',
	message: 'Node type "n8n-nodes-base.dateTime" is blocked by an instance policy',
	subject: 'n8n-nodes-base.dateTime',
	subjectType: 'nodeType',
};

function setUp() {
	const backend = mock<PolicyEnforcementBackend>();
	backend.enforce.mockResolvedValue({ violations: [] });
	backend.evaluate.mockResolvedValue({ violations: [] });
	const enforcement = new PolicyEnforcementService();
	enforcement.setImplementation(backend);
	return { backend, service: new AgentPolicyService(enforcement) };
}

describe('AgentPolicyService', () => {
	it('saves through workflowSave, as an agent whose nodes are its node tools', async () => {
		const { backend, service } = setUp();

		await service.enforceSave('proj-1', 'agent-1', agent([dateTimeTool]), agent([]));

		expect(backend.enforce).toHaveBeenCalledWith('workflowSave', {
			workflow: {
				id: 'agent-1',
				name: 'Support agent',
				artifactKind: 'agent',
				nodes: [expect.objectContaining({ type: 'n8n-nodes-base.dateTime', typeVersion: 2 })],
			},
			storedWorkflow: { id: 'agent-1', name: 'Support agent', artifactKind: 'agent', nodes: [] },
			projectId: 'proj-1',
		});
	});

	it('passes no stored workflow for a create', async () => {
		const { backend, service } = setUp();

		await service.enforceSave('proj-1', null, agent([dateTimeTool]), null);

		expect(backend.enforce).toHaveBeenCalledWith(
			'workflowSave',
			expect.objectContaining({ storedWorkflow: null }),
		);
	});

	it('throws the violations when a policy refuses a publish', async () => {
		const { backend, service } = setUp();
		backend.enforce.mockResolvedValue({ violations: [violation] });

		const error = await service
			.enforcePublish('proj-1', 'agent-1', agent([dateTimeTool]))
			.catch((e: unknown) => e);

		expect(backend.enforce).toHaveBeenCalledWith('workflowPublish', expect.anything());
		expect(error).toBeInstanceOf(PolicyViolationError);
		expect((error as PolicyViolationError).violations).toEqual([violation]);
	});

	it('returns the violations of an advisory publish check without throwing', async () => {
		const { backend, service } = setUp();
		backend.evaluate.mockResolvedValue({ violations: [violation] });

		await expect(
			service.evaluatePublish('proj-1', 'agent-1', agent([dateTimeTool])),
		).resolves.toEqual([violation]);
	});
});
