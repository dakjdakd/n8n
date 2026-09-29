/**
 * Pins the workflow list's restricted node filter to what enforcement refuses: the version a
 * workflow runs, judged by its owner project. Only a real query can show that the page and the
 * count agree, so this runs against the database.
 */
import {
	createActiveWorkflow,
	createTeamProject,
	createWorkflow,
	testDb,
} from '@n8n/backend-test-utils';
import { LICENSE_FEATURES } from '@n8n/constants';
import { WorkflowDependencies, WorkflowDependencyRepository, type User } from '@n8n/db';
import { Container } from '@n8n/di';
import type { INode } from 'n8n-workflow';
import { v4 as uuid } from 'uuid';

import { createOwner } from '../shared/db/users';
import type { SuperAgentTest } from '../shared/types';
import * as utils from '../shared/utils/';
import { clearPolicyCache } from './shared/policy-cache';

const MANUAL_TRIGGER = 'n8n-nodes-base.manualTrigger';
const SLACK = 'n8n-nodes-base.slack';
const HTTP_REQUEST = 'n8n-nodes-base.httpRequest';

const testServer = utils.setupTestServer({
	endpointGroups: ['workflows', 'type-availability-policies'],
	modules: ['policy-infrastructure', 'type-availability-policies'],
	enabledFeatures: [LICENSE_FEATURES.TYPE_AVAILABILITY_POLICIES],
});

let owner: User;
let ownerAgent: SuperAgentTest;

const node = (type: string): INode => ({
	id: uuid(),
	name: type,
	type,
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
});

const denySlack = {
	rules: [{ id: 'deny-slack', action: 'deny', selector: { kind: 'name', value: SLACK } }],
	defaultAction: 'allow',
	version: 0,
};

/** Replaces the index rows of one version, as the indexer does after a save or a publish. */
async function indexVersion(
	workflow: { id: string; versionCounter: number },
	publishedVersionId: string | null,
	nodeTypes: string[],
) {
	const dependencies = new WorkflowDependencies(
		workflow.id,
		workflow.versionCounter + 1,
		publishedVersionId,
	);
	for (const nodeType of nodeTypes) {
		dependencies.add({ dependencyType: 'nodeType', dependencyKey: nodeType, dependencyInfo: null });
	}
	await Container.get(WorkflowDependencyRepository).updateDependenciesForWorkflow(
		workflow.id,
		dependencies,
	);
}

async function listRestricted(projectId?: string) {
	const filter = JSON.stringify({
		wontExecute: ['restrictedNode'],
		...(projectId && { projectId }),
	});
	const response = await ownerAgent.get('/workflows').query({ filter }).expect(200);

	return {
		ids: response.body.data.map((workflow: { id: string }) => workflow.id).sort(),
		count: response.body.count,
	};
}

beforeAll(async () => {
	owner = await createOwner();
	ownerAgent = testServer.authAgentFor(owner);
});

afterEach(async () => {
	await testDb.truncate([
		'TypeAvailabilityPolicyAttachment',
		'TypeAvailabilityPolicyScope',
		'TypeAvailabilityPolicy',
		'WorkflowDependency',
		'SharedWorkflow',
		'WorkflowPublishedVersion',
		'WorkflowPublishHistory',
		// A published workflow references its history row, so the workflow goes first.
		'WorkflowEntity',
		'WorkflowHistory',
	]);
	await clearPolicyCache();
});

describe('GET /workflows with the restricted node filter', () => {
	test('matches the version each workflow runs, in the page and in the count', async () => {
		const unpublishedWithSlack = await createWorkflow(
			{ nodes: [node(MANUAL_TRIGGER), node(SLACK)] },
			owner,
		);
		await createWorkflow({ nodes: [node(MANUAL_TRIGGER)] }, owner);

		// Published with Slack, while the draft no longer has it: production still runs Slack.
		const publishedWithSlack = await createActiveWorkflow({ nodes: [node(MANUAL_TRIGGER)] }, owner);
		await indexVersion(publishedWithSlack, publishedWithSlack.activeVersionId, [
			MANUAL_TRIGGER,
			SLACK,
		]);

		// Slack only in the draft: production runs the published version, which is clean.
		const draftOnlySlack = await createActiveWorkflow(
			{ nodes: [node(MANUAL_TRIGGER), node(SLACK)] },
			owner,
		);
		await indexVersion(draftOnlySlack, draftOnlySlack.activeVersionId, [MANUAL_TRIGGER]);

		await ownerAgent.put('/node-type-policies/instance').send(denySlack).expect(200);

		expect(await listRestricted()).toEqual({
			ids: [unpublishedWithSlack.id, publishedWithSlack.id].sort(),
			count: 2,
		});
	});

	test("judges each workflow by its owner project's policy", async () => {
		const restrictingProject = await createTeamProject('Restricts Slack', owner);
		const otherProject = await createTeamProject('Allows Slack', owner);
		const restricted = await createWorkflow({ nodes: [node(SLACK)] }, restrictingProject);
		await createWorkflow({ nodes: [node(SLACK)] }, otherProject);

		await ownerAgent
			.put(`/projects/${restrictingProject.id}/node-type-policies/project`)
			.send(denySlack)
			.expect(200);

		expect(await listRestricted()).toEqual({ ids: [restricted.id], count: 1 });
		expect(await listRestricted(otherProject.id)).toEqual({ ids: [], count: 0 });
	});

	test('applies the instance verdict with and without a project policy', async () => {
		const optsIn = await createTeamProject('Opts in to Slack', owner);
		const noPolicy = await createTeamProject('No policy', owner);
		await createWorkflow({ nodes: [node(SLACK)] }, optsIn);
		const deniedByInstance = await createWorkflow({ nodes: [node(HTTP_REQUEST)] }, optsIn);
		const delegatedWithoutOptIn = await createWorkflow({ nodes: [node(SLACK)] }, noPolicy);

		await ownerAgent
			.put('/node-type-policies/instance')
			.send({
				rules: [
					{ id: 'deny-http', action: 'deny', selector: { kind: 'name', value: HTTP_REQUEST } },
					{ id: 'delegate-slack', action: 'delegate', selector: { kind: 'name', value: SLACK } },
				],
				defaultAction: 'allow',
				version: 0,
			})
			.expect(200);
		await ownerAgent
			.put(`/projects/${optsIn.id}/node-type-policies/project`)
			.send({
				rules: [{ id: 'allow-slack', action: 'allow', selector: { kind: 'name', value: SLACK } }],
				defaultAction: 'allow',
				version: 0,
			})
			.expect(200);

		expect(await listRestricted()).toEqual({
			ids: [deniedByInstance.id, delegatedWithoutOptIn.id].sort(),
			count: 2,
		});
	});

	test('matches nothing when no policy restricts a node type in use', async () => {
		await createWorkflow({ nodes: [node(SLACK)] }, owner);

		expect(await listRestricted()).toEqual({ ids: [], count: 0 });
	});
});
