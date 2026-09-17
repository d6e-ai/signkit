import { resolveContactApplication } from '$lib/application/contacts/contact-runtime';
import { createContactHttpHandlers } from '$lib/http/contacts';

const handlers = createContactHttpHandlers(resolveContactApplication);

export const GET = handlers.list;
export const POST = handlers.create;
