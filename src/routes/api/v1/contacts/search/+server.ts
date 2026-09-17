import { resolveContactApplication } from '$lib/application/contacts/contact-runtime';
import { createContactHttpHandlers } from '$lib/http/contacts';

export const POST = createContactHttpHandlers(resolveContactApplication).search;
