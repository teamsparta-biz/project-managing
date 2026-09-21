# Project Instructions

## Brainstorming Skill Trigger

Invoke `superpowers:brainstorming` only when the user explicitly names or directly requests the brainstorming skill, for example `brainstorming`, `브레인스토밍`, or `/superpowers:brainstorming`.

Do not invoke it solely because a request involves creative work, a feature, a component, a behavior change, planning, design, or implementation.

## Obsidian Naming

When referring to Obsidian (the note-taking app) in conversation, call it "옵시" instead of "옵시디언".

## Obsidian Note Trigger

When the user says "해당 내용은 옵시에 추가해줘" (or an equivalent phrasing), organize the relevant preceding conversation content into a markdown note and save it as a new file in the Obsidian vault (`/Users/teamsparta/Documents/Obsidian Vault`). Obsidian is the user's personal knowledge base ("새로운 나") — write notes in a clear, well-structured, first-person-appropriate form meant for the user's own future reference, not as a transcript of the conversation.

## Email Lookup

When the user needs to find someone's email address, search ax-hub (`mcp__ax-hub__query_sql` / `list_tables` / `describe_table`) or Gmail (`mcp__claude_ai_Gmail__search_threads`, `get_message`, etc.) to retrieve it, rather than asking the user or guessing. Try ax-hub first if the person is likely a tutor/instructor/company contact tracked there; fall back to searching Gmail threads/messages if not found.

## Calendar Add Trigger

When the user says "일정에 추가해줘" (or an equivalent phrasing), create the relevant event discussed in the conversation on Google Calendar (`mcp__claude_ai_Google_Calendar__create_event`). If the date/time is ambiguous (e.g. AM/PM unclear), ask the user to clarify before creating the event.

## To-Do Management

The user manages their to-dos in Google Calendar (not Notion, not Google Tasks — no Google Tasks connector is available). When the user wants to add, check, or manage a to-do/task item, create/check it as a Google Calendar event rather than using Notion. (A Notion database "할일 (Chanho)" was created earlier and holds some older to-dos, but it is no longer the active system going forward.)
