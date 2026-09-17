import type { RequestHandler } from '@sveltejs/kit';
import { z, type ZodIssue } from 'zod';
import {
	InvalidContactRequestError,
	type ContactApplicationPort,
	type CreateContactResult,
	type DeleteContactResult,
	type ListContactsResult,
	type UpdateContactResult
} from '$lib/application/contacts/contact-service';
import {
	DEFAULT_CONTACT_LIST_LIMIT,
	MAX_CONTACT_LIST_LIMIT,
	MAX_CONTACT_UPDATE_EXPECTED_VERSION,
	MAX_CONTACT_VERSION
} from '$lib/ports/contact-store';
import { acceptsJson, readJsonBody, validationErrors } from './bounded-json-body';
import { signkitIdentifierSchema } from './identifier-schema';
import { authorizeInstanceRequest, type AuthorizedInstanceActor } from './instance-authorization';
import { problemResponse } from './problem';

const MUTATION_BODY_BYTES: number = 4 * 1024;
const SEARCH_BODY_BYTES: number = 2 * 1024;

const idempotencyKeySchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[\x21-\x7E]+$/);
const contactFields = {
	name: z.string().trim().min(1).max(200),
	email: z.string().trim().email().max(320),
	locale: z.enum(['en', 'ja'])
};
const createSchema = z.object(contactFields).strict();
const updateSchema = z
	.object({
		expectedVersion: z.number().int().min(1).max(MAX_CONTACT_UPDATE_EXPECTED_VERSION),
		...contactFields
	})
	.strict();
const deleteSchema = z
	.object({ expectedVersion: z.number().int().min(1).max(MAX_CONTACT_VERSION) })
	.strict();
const listSchema = z
	.object({
		cursor: signkitIdentifierSchema.optional(),
		limit: z.coerce
			.number()
			.int()
			.min(1)
			.max(MAX_CONTACT_LIST_LIMIT)
			.default(DEFAULT_CONTACT_LIST_LIMIT)
	})
	.strict();
const searchSchema = z
	.object({
		query: z.string().trim().min(1).max(200),
		cursor: signkitIdentifierSchema.optional(),
		limit: z.number().int().min(1).max(MAX_CONTACT_LIST_LIMIT).default(DEFAULT_CONTACT_LIST_LIMIT)
	})
	.strict();

interface ResolverContext {
	platform?: Readonly<App.Platform>;
}

export type ContactApplicationResolver = (
	context: ResolverContext
) => ContactApplicationPort | null | Promise<ContactApplicationPort | null>;

export interface ContactHttpHandlers {
	create: RequestHandler;
	list: RequestHandler;
	search: RequestHandler;
	update: RequestHandler;
	delete: RequestHandler;
}

export function createContactHttpHandlers(
	resolveApplication: ContactApplicationResolver
): ContactHttpHandlers {
	const list: RequestHandler = async ({ locals, platform, request, url }): Promise<Response> => {
		const actor = authorizeContactRequest(locals, request, url.pathname);
		if (actor instanceof Response) return actor;
		const parsed = listSchema.safeParse(Object.fromEntries(url.searchParams));
		if (!parsed.success)
			return validation(
				url.pathname,
				'The contact list query did not match the required schema.',
				parsed.error.issues
			);
		const application = await resolveOrProblem(resolveApplication, platform, url.pathname);
		if (application instanceof Response) return application;
		try {
			return listResponse(
				await application.list(
					{ id: actor.id },
					{ cursor: parsed.data.cursor ?? null, limit: parsed.data.limit, query: null }
				),
				url.pathname
			);
		} catch (error: unknown) {
			return failed('contact_list_failed', error, url.pathname);
		}
	};

	const search: RequestHandler = async ({ locals, platform, request, url }): Promise<Response> => {
		const actor = authorizeContactRequest(locals, request, url.pathname);
		if (actor instanceof Response) return actor;
		const parsedBody = await jsonBody(request, SEARCH_BODY_BYTES, url.pathname, 'Contact search');
		if (parsedBody instanceof Response) return parsedBody;
		const parsed = searchSchema.safeParse(parsedBody);
		if (!parsed.success)
			return validation(
				url.pathname,
				'The contact search request did not match the required schema.',
				parsed.error.issues
			);
		const application = await resolveOrProblem(resolveApplication, platform, url.pathname);
		if (application instanceof Response) return application;
		try {
			return listResponse(
				await application.list(
					{ id: actor.id },
					{ query: parsed.data.query, cursor: parsed.data.cursor ?? null, limit: parsed.data.limit }
				),
				url.pathname
			);
		} catch (error: unknown) {
			if (error instanceof InvalidContactRequestError)
				return validation(url.pathname, error.message, [
					{ path: [], message: error.message, code: 'custom' }
				]);
			return failed('contact_search_failed', error, url.pathname);
		}
	};

	const create: RequestHandler = async ({ locals, platform, request, url }): Promise<Response> => {
		const actor = authorizeContactRequest(locals, request, url.pathname);
		if (actor instanceof Response) return actor;
		const key = requireIdempotency(request, url.pathname);
		if (key instanceof Response) return key;
		const parsedBody = await jsonBody(
			request,
			MUTATION_BODY_BYTES,
			url.pathname,
			'Contact creation'
		);
		if (parsedBody instanceof Response) return parsedBody;
		const parsed = createSchema.safeParse(parsedBody);
		if (!parsed.success)
			return validation(
				url.pathname,
				'The contact creation request did not match the required schema.',
				parsed.error.issues
			);
		const application = await resolveOrProblem(resolveApplication, platform, url.pathname);
		if (application instanceof Response) return application;
		try {
			return mutationResponse(
				await application.create({ id: actor.id }, { idempotencyKey: key, ...parsed.data }),
				url.pathname,
				'create'
			);
		} catch (error: unknown) {
			if (error instanceof InvalidContactRequestError)
				return validation(url.pathname, error.message, [
					{ path: [], message: error.message, code: 'custom' }
				]);
			return failed('contact_create_failed', error, url.pathname);
		}
	};

	const update: RequestHandler = async ({
		locals,
		params,
		platform,
		request,
		url
	}): Promise<Response> => {
		const actor = authorizeContactRequest(locals, request, url.pathname);
		if (actor instanceof Response) return actor;
		const key = requireIdempotency(request, url.pathname);
		if (key instanceof Response) return key;
		const parsedBody = await jsonBody(request, MUTATION_BODY_BYTES, url.pathname, 'Contact update');
		if (parsedBody instanceof Response) return parsedBody;
		const parsed = updateSchema.safeParse(parsedBody);
		if (!parsed.success)
			return validation(
				url.pathname,
				'The contact update request did not match the required schema.',
				parsed.error.issues
			);
		const application = await resolveOrProblem(resolveApplication, platform, url.pathname);
		if (application instanceof Response) return application;
		try {
			return mutationResponse(
				await application.update({ id: actor.id }, params.contactId ?? '', {
					idempotencyKey: key,
					...parsed.data
				}),
				url.pathname,
				'update'
			);
		} catch (error: unknown) {
			if (error instanceof InvalidContactRequestError)
				return validation(url.pathname, error.message, [
					{ path: [], message: error.message, code: 'custom' }
				]);
			return failed('contact_update_failed', error, url.pathname);
		}
	};

	const remove: RequestHandler = async ({
		locals,
		params,
		platform,
		request,
		url
	}): Promise<Response> => {
		const actor = authorizeContactRequest(locals, request, url.pathname);
		if (actor instanceof Response) return actor;
		const key = requireIdempotency(request, url.pathname);
		if (key instanceof Response) return key;
		const parsedBody = await jsonBody(request, SEARCH_BODY_BYTES, url.pathname, 'Contact deletion');
		if (parsedBody instanceof Response) return parsedBody;
		const parsed = deleteSchema.safeParse(parsedBody);
		if (!parsed.success)
			return validation(
				url.pathname,
				'The contact deletion request did not match the required schema.',
				parsed.error.issues
			);
		const application = await resolveOrProblem(resolveApplication, platform, url.pathname);
		if (application instanceof Response) return application;
		try {
			return deleteResponse(
				await application.delete({ id: actor.id }, params.contactId ?? '', {
					idempotencyKey: key,
					...parsed.data
				}),
				url.pathname
			);
		} catch (error: unknown) {
			if (error instanceof InvalidContactRequestError)
				return validation(url.pathname, error.message, [
					{ path: [], message: error.message, code: 'custom' }
				]);
			return failed('contact_delete_failed', error, url.pathname);
		}
	};

	return { create, list, search, update, delete: remove };
}

function authorizeContactRequest(
	locals: App.Locals,
	request: Request,
	instance: string
): AuthorizedInstanceActor | Response {
	const authorized: AuthorizedInstanceActor | Response = authorizeInstanceRequest(locals, instance);
	if (authorized instanceof Response) return authorized;
	if ((request.headers.get('authorization') ?? '').trim().length > 0) {
		return problemResponse({
			type: 'urn:signkit:problem:credential-not-permitted',
			title: 'Bearer credentials are not accepted here',
			status: 403,
			detail: 'This endpoint requires an interactive operator session without a bearer credential.',
			instance
		});
	}
	return authorized;
}

async function resolveOrProblem(
	resolveApplication: ContactApplicationResolver,
	platform: Readonly<App.Platform> | undefined,
	instance: string
): Promise<ContactApplicationPort | Response> {
	try {
		const application = await resolveApplication({ platform });
		if (application !== null) return application;
	} catch (error: unknown) {
		console.error(
			JSON.stringify({
				event: 'contact_resolution_failed',
				message: error instanceof Error ? error.name : 'UnknownError'
			})
		);
	}
	return problemResponse({
		type: 'urn:signkit:problem:persistence-unavailable',
		title: 'Contact persistence unavailable',
		status: 503,
		detail: 'The durable contact store is not configured for this deployment.',
		instance
	});
}

function requireIdempotency(request: Request, instance: string): string | Response {
	const parsed = idempotencyKeySchema.safeParse(request.headers.get('idempotency-key'));
	return parsed.success
		? parsed.data
		: problemResponse({
				type: 'urn:signkit:problem:idempotency-key-required',
				title: 'Valid Idempotency-Key required',
				status: 400,
				detail: 'Contact mutations require one non-empty visible-ASCII Idempotency-Key header.',
				instance,
				errors: parsed.success ? [] : validationErrors(parsed.error.issues)
			});
}

async function jsonBody(
	request: Request,
	maxBytes: number,
	instance: string,
	operation: string
): Promise<unknown | Response> {
	if (!acceptsJson(request))
		return problemResponse({
			type: 'urn:signkit:problem:unsupported-media-type',
			title: 'Unsupported media type',
			status: 415,
			detail: `${operation} requires an application/json request body.`,
			instance
		});
	const body = await readJsonBody(request, maxBytes);
	if (body.ok) return body.value;
	return problemResponse(
		body.reason === 'too_large'
			? {
					type: 'urn:signkit:problem:request-body-too-large',
					title: 'Request body too large',
					status: 413,
					detail: `The request body must not exceed ${maxBytes} bytes.`,
					instance
				}
			: {
					type: 'urn:signkit:problem:invalid-json',
					title: 'Invalid JSON',
					status: 400,
					detail: 'The request body must be valid JSON.',
					instance
				}
	);
}

function validation(instance: string, detail: string, issues: readonly ZodIssue[]): Response {
	return problemResponse({
		type: 'urn:signkit:problem:validation-failed',
		title: 'Request validation failed',
		status: 400,
		detail,
		instance,
		errors: validationErrors(issues)
	});
}

function listResponse(result: ListContactsResult, instance: string): Response {
	if (result.outcome === 'owner_not_active') return ownerNotActive(instance);
	return json({ items: result.page.items, nextCursor: result.page.nextCursor }, 200);
}

function mutationResponse(
	result: CreateContactResult | UpdateContactResult,
	instance: string,
	kind: 'create' | 'update'
): Response {
	if (
		result.outcome === 'created' ||
		result.outcome === 'updated' ||
		result.outcome === 'replayed'
	) {
		return json(
			{ contact: result.contact },
			result.outcome === 'created' ? 201 : 200,
			result.outcome === 'replayed'
		);
	}
	return outcomeProblem(result.outcome, instance, kind);
}

function deleteResponse(result: DeleteContactResult, instance: string): Response {
	if (result.outcome === 'deleted' || result.outcome === 'replayed') {
		return json(
			{ deleted: { id: result.contactId, deletedAt: result.deletedAt } },
			200,
			result.outcome === 'replayed'
		);
	}
	return outcomeProblem(result.outcome, instance, 'delete');
}

function outcomeProblem(outcome: string, instance: string, kind: string): Response {
	if (outcome === 'owner_not_active') return ownerNotActive(instance);
	const definitions: Record<
		string,
		{ type: string; title: string; status: number; detail: string }
	> = {
		not_found: {
			type: 'urn:signkit:problem:contact-not-found',
			title: 'Contact not found',
			status: 404,
			detail: 'No contact was found for the authenticated caller.'
		},
		email_conflict: {
			type: 'urn:signkit:problem:contact-email-conflict',
			title: 'Contact email conflict',
			status: 409,
			detail: 'A contact already uses that normalized email address.'
		},
		version_conflict: {
			type: 'urn:signkit:problem:contact-version-conflict',
			title: 'Contact version conflict',
			status: 409,
			detail: 'The contact changed after the caller read it.'
		},
		idempotency_conflict: {
			type: 'urn:signkit:problem:contact-idempotency-conflict',
			title: 'Idempotency key conflict',
			status: 409,
			detail: `The Idempotency-Key was already used for a different contact ${kind} request.`
		},
		integrity_error: {
			type: 'urn:signkit:problem:contact-integrity-error',
			title: 'Contact integrity check failed',
			status: 503,
			detail: 'The contact operation could not prove a consistent state.'
		}
	};
	return problemResponse({ ...(definitions[outcome] ?? definitions.integrity_error), instance });
}

function ownerNotActive(instance: string): Response {
	return problemResponse({
		type: 'urn:signkit:problem:contact-owner-not-active',
		title: 'Contact owner is not active',
		status: 403,
		detail: 'The authenticated caller is not an active instance member.',
		instance
	});
}

function failed(event: string, error: unknown, instance: string): Response {
	console.error(
		JSON.stringify({ event, message: error instanceof Error ? error.name : 'UnknownError' })
	);
	return problemResponse({
		type: 'urn:signkit:problem:service-unavailable',
		title: 'Contact service unavailable',
		status: 503,
		detail: 'The contact operation could not be completed.',
		instance
	});
}

function json(value: unknown, status: number, replayed: boolean = false): Response {
	const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
	if (replayed) headers.set('idempotency-replayed', 'true');
	return new Response(JSON.stringify(value), { status, headers });
}
