import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

type ParsedWindow = {
	startDate: string;
	endDate: string;
	daysOfWeek: string[];
	startTimeOfDay: string;
	endTimeOfDay: string;
	excludedDates: string[];
};

const DAY_TO_NUMBER: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export const POST: RequestHandler = async ({ request, platform }) => {
	const env = platform?.env;
	if (!env) throw error(500, 'Platform env not available');
	const expectedKey = env.SCOUT_API_KEY;
	if (!expectedKey) throw error(500, 'SCOUT_API_KEY is not configured');
	const auth = request.headers.get('authorization') || '';
	if (auth !== `Bearer ${expectedKey}`) throw error(401, 'Unauthorized');

	const body = await request.json().catch(() => null) as { title?: string; durationMinutes?: number; parsedWindow?: ParsedWindow } | null;
	if (!body?.title || !body?.durationMinutes || !body?.parsedWindow) throw error(400, 'Missing title, durationMinutes, or parsedWindow');
	const parsedWindow = normalizeWindow(body.parsedWindow);
	const duration = Number(body.durationMinutes);
	if (!Number.isInteger(duration) || duration <= 0 || duration > 240) throw error(400, 'Invalid durationMinutes');

	const db = env.DB;
	const user = await db.prepare('SELECT id, slug FROM users WHERE email = ? LIMIT 1')
		.bind(env.ADMIN_EMAIL || 'andrew@fraser.vn')
		.first<{ id: string; slug: string }>() ||
		await db.prepare('SELECT id, slug FROM users LIMIT 1').first<{ id: string; slug: string }>();
	if (!user) throw error(409, 'CloudMeet admin user is not initialized; login with Andrew first');

	const id = crypto.randomUUID();
	const slug = makeSlug(body.title);
	await db.prepare(
		`INSERT INTO event_types (id, user_id, name, duration_minutes, buffer_minutes, slug, description, location_type, is_active, availability_calendars, invite_calendar, scout_window, created_at)
		 VALUES (?, ?, ?, ?, 15, ?, ?, 'google_meet', 1, 'google', 'google', ?, CURRENT_TIMESTAMP)`
	).bind(id, user.id, body.title, duration, slug, 'Scout per-candidate interview link', JSON.stringify(parsedWindow)).run();

	for (const day of parsedWindow.daysOfWeek) {
		await db.prepare(
			`INSERT INTO availability_rules (user_id, event_type_id, day_of_week, start_time, end_time, is_active, created_at)
			 VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`
		).bind(user.id, id, DAY_TO_NUMBER[day], parsedWindow.startTimeOfDay, parsedWindow.endTimeOfDay).run();
	}

	const appUrl = String(env.APP_URL || env.BASE_URL || '').replace(/\/+$/, '');
	return json({ url: `${appUrl}/${slug}`, slug, eventTypeId: id });
};

function normalizeWindow(raw: ParsedWindow): ParsedWindow {
	if (!raw || typeof raw !== 'object') throw error(400, 'Invalid parsedWindow');
	const out = {
		startDate: raw.startDate,
		endDate: raw.endDate,
		daysOfWeek: Array.isArray(raw.daysOfWeek) ? raw.daysOfWeek.map((d) => String(d).toLowerCase()) : [],
		startTimeOfDay: raw.startTimeOfDay || '09:00',
		endTimeOfDay: raw.endTimeOfDay || '17:00',
		excludedDates: Array.isArray(raw.excludedDates) ? raw.excludedDates : []
	};
	if (!/^\d{4}-\d{2}-\d{2}$/.test(out.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(out.endDate)) throw error(400, 'Invalid date range');
	if (out.endDate < out.startDate) throw error(400, 'endDate is before startDate');
	if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(out.startTimeOfDay) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(out.endTimeOfDay)) throw error(400, 'Invalid time range');
	if (out.startTimeOfDay >= out.endTimeOfDay) throw error(400, 'endTimeOfDay must be after startTimeOfDay');
	if (!out.daysOfWeek.length || !out.daysOfWeek.every((d) => d in DAY_TO_NUMBER)) throw error(400, 'Invalid daysOfWeek');
	if (!out.excludedDates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)))) throw error(400, 'Invalid excludedDates');
	return out;
}

function makeSlug(title: string): string {
	const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42) || 'scout-interview';
	const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
	return `${base}-${suffix}`;
}
