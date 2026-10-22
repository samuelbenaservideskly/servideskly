/**
 * The worked examples on Settings - Advanced - API keys, in the languages a
 * caller is likely to write in. One language bar sets them all (radio
 * buttons and CSS, no script): pick Python once and every example is Python.
 *
 * Every snippet reads the key from the HELPDESK_KEY environment variable
 * rather than showing a place to paste it - a key written into source code is
 * a key committed to a repository.
 */

export const API_LANGUAGES = [
  { key: 'curl', label: 'cURL' },
  // Not a language: an app. Its "code" is what to fill in where.
  { key: 'postman', label: 'Postman' },
  { key: 'powershell', label: 'PowerShell' },
  { key: 'python', label: 'Python' },
  { key: 'javascript', label: 'JavaScript' },
  { key: 'csharp', label: 'C#' },
  { key: 'java', label: 'Java' },
  { key: 'go', label: 'Go' },
  { key: 'php', label: 'PHP' },
] as const;
export type ApiLanguage = (typeof API_LANGUAGES)[number]['key'];

type Body = Record<string, string>;

const json = (body: Body, indent: string): string =>
  JSON.stringify(body, null, 2).split('\n').map((line, i) => (i === 0 ? line : indent + line)).join('\n');

const quoted = (value: string, quote: '"' | "'"): string =>
  quote + value.replace(/\\/g, '\\\\').split(quote).join('\\' + quote) + quote;

/** One request in one language: a POST, or a PATCH for changing a ticket. */
export function apiSnippet(language: ApiLanguage, url: string, body: Body, method: 'POST' | 'PATCH' = 'POST'): string {
  const keys = Object.keys(body);
  const Title = method === 'POST' ? 'Post' : 'Patch';
  switch (language) {
    case 'curl':
      return [
        'curl -X ' + method + ' "' + url + '" \\',
        '  -H "Authorization: Bearer $HELPDESK_KEY" \\',
        '  -H "Content-Type: application/json" \\',
        "  -d '" + JSON.stringify(body) + "'",
      ].join('\n');

    case 'postman':
      return [
        'In Postman: New > HTTP request, then fill in:',
        '',
        '  Method          ' + method,
        '  URL             ' + url,
        '',
        '  Authorization tab',
        '    Auth Type     Bearer Token',
        '    Token         {{helpdeskKey}}',
        '',
        '  Body tab',
        '    raw, and JSON in the drop-down beside it',
        '    ' + JSON.stringify(body, null, 2).split('\n').join('\n    '),
        '',
        'Press Send. The answer appears underneath.',
        '',
        '{{helpdeskKey}} is a Postman variable: under Environments, add',
        'helpdeskKey with your key as its value (type secret), and choose',
        'that environment top right - so the key is not saved in the request.',
        '',
        'Shortcut: Import > Raw text, and paste the cURL example.',
      ].join('\n');

    case 'powershell':
      return [
        '$headers = @{ Authorization = "Bearer $env:HELPDESK_KEY" }',
        '$body = @{',
        ...keys.map((k) => '    ' + k + ' = ' + quoted(body[k]!, '"')),
        '} | ConvertTo-Json',
        '',
        'Invoke-RestMethod -Method ' + Title + ' -Uri "' + url + '" `',
        '    -Headers $headers -ContentType "application/json" -Body $body',
      ].join('\n');

    case 'python':
      return [
        'import os',
        'import requests',
        '',
        'response = requests.' + method.toLowerCase() + '(',
        '    "' + url + '",',
        '    headers={"Authorization": "Bearer " + os.environ["HELPDESK_KEY"]},',
        '    json=' + json(body, '    ') + ',',
        '    timeout=30,',
        ')',
        'response.raise_for_status()',
        'print(response.json())',
      ].join('\n');

    case 'javascript':
      return [
        '// Node.js 18 or later',
        'const response = await fetch("' + url + '", {',
        '  method: "' + method + '",',
        '  headers: {',
        '    Authorization: `Bearer ${process.env.HELPDESK_KEY}`,',
        '    "Content-Type": "application/json",',
        '  },',
        '  body: JSON.stringify(' + json(body, '  ') + '),',
        '});',
        'console.log(await response.json());',
      ].join('\n');

    case 'csharp':
      return [
        'using System.Net.Http.Headers;',
        'using System.Net.Http.Json;',
        '',
        'using var client = new HttpClient();',
        'client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(',
        '    "Bearer", Environment.GetEnvironmentVariable("HELPDESK_KEY"));',
        '',
        'var response = await client.' + Title + 'AsJsonAsync("' + url + '", new',
        '{',
        ...keys.map((k) => '    ' + k + ' = ' + quoted(body[k]!, '"') + ','),
        '});',
        'Console.WriteLine(await response.Content.ReadAsStringAsync());',
      ].join('\n');

    case 'java':
      return [
        'import java.net.URI;',
        'import java.net.http.HttpClient;',
        'import java.net.http.HttpRequest;',
        'import java.net.http.HttpResponse;',
        '',
        'var body = """',
        '    ' + JSON.stringify(body),
        '    """;',
        'var request = HttpRequest.newBuilder(URI.create("' + url + '"))',
        '    .header("Authorization", "Bearer " + System.getenv("HELPDESK_KEY"))',
        '    .header("Content-Type", "application/json")',
        method === 'POST' ? '    .POST(HttpRequest.BodyPublishers.ofString(body))' : '    .method("PATCH", HttpRequest.BodyPublishers.ofString(body))',
        '    .build();',
        'var response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());',
        'System.out.println(response.body());',
      ].join('\n');

    case 'go':
      return [
        'package main',
        '',
        'import (',
        '\t"bytes"',
        '\t"fmt"',
        '\t"io"',
        '\t"net/http"',
        '\t"os"',
        ')',
        '',
        'func main() {',
        '\tbody := []byte(`' + JSON.stringify(body) + '`)',
        '\treq, _ := http.NewRequest("' + method + '", "' + url + '", bytes.NewReader(body))',
        '\treq.Header.Set("Authorization", "Bearer "+os.Getenv("HELPDESK_KEY"))',
        '\treq.Header.Set("Content-Type", "application/json")',
        '\tresp, err := http.DefaultClient.Do(req)',
        '\tif err != nil {',
        '\t\tpanic(err)',
        '\t}',
        '\tdefer resp.Body.Close()',
        '\tout, _ := io.ReadAll(resp.Body)',
        '\tfmt.Println(string(out))',
        '}',
      ].join('\n');

    case 'php':
      return [
        '<?php',
        "$ch = curl_init('" + url + "');",
        'curl_setopt_array($ch, [',
        method === 'POST' ? '    CURLOPT_POST => true,' : "    CURLOPT_CUSTOMREQUEST => 'PATCH',",
        '    CURLOPT_RETURNTRANSFER => true,',
        '    CURLOPT_HTTPHEADER => [',
        "        'Authorization: Bearer ' . getenv('HELPDESK_KEY'),",
        "        'Content-Type: application/json',",
        '    ],',
        '    CURLOPT_POSTFIELDS => json_encode([',
        ...keys.map((k) => '        ' + quoted(k, "'") + ' => ' + quoted(body[k]!, "'") + ','),
        '    ]),',
        ']);',
        'echo curl_exec($ch);',
      ].join('\n');
  }
}

/**
 * Sending a file: a multipart upload (what a browser and Postman's form-data
 * send), the file's bytes as they are. Java has no multipart helper in its
 * standard library, so it sends the other way the endpoint accepts: JSON with
 * the file as base64.
 */
export function apiFileSnippet(language: ApiLanguage, url: string): string {
  switch (language) {
    case 'curl':
      return [
        'curl -X POST "' + url + '" \\',
        '  -H "Authorization: Bearer $HELPDESK_KEY" \\',
        '  -F "ticket=INC-000123" \\',
        '  -F "file=@screenshot.png" \\',
        '  -F "file=@log.txt"',
      ].join('\n');
    case 'postman':
      return [
        'In Postman: New > HTTP request, then fill in:',
        '',
        '  Method          POST',
        '  URL             ' + url,
        '',
        '  Authorization tab',
        '    Auth Type     Bearer Token',
        '    Token         {{helpdeskKey}}',
        '',
        '  Body tab: form-data',
        '    Key  ticket   (Text)   Value  INC-000123',
        '    Key  file     (File)   Value  Select files... (pick one or several)',
        '',
        '  To choose File, hover over the Key cell: a Text / File drop-down appears.',
        '',
        'Press Send.',
      ].join('\n');
    case 'powershell':
      return [
        '# PowerShell 7 or later',
        '$headers = @{ Authorization = "Bearer $env:HELPDESK_KEY" }',
        '$form = @{',
        '    ticket = "INC-000123"',
        '    file   = Get-Item "screenshot.png"',
        '}',
        '',
        'Invoke-RestMethod -Method Post -Uri "' + url + '" -Headers $headers -Form $form',
      ].join('\n');
    case 'python':
      return [
        'import os',
        'import requests',
        '',
        'with open("screenshot.png", "rb") as screenshot:',
        '    response = requests.post(',
        '        "' + url + '",',
        '        headers={"Authorization": "Bearer " + os.environ["HELPDESK_KEY"]},',
        '        data={"ticket": "INC-000123"},',
        '        files=[("file", ("screenshot.png", screenshot))],',
        '        timeout=60,',
        '    )',
        'response.raise_for_status()',
        'print(response.json())',
      ].join('\n');
    case 'javascript':
      return [
        '// Node.js 20 or later',
        'import { openAsBlob } from "node:fs";',
        '',
        'const form = new FormData();',
        'form.append("ticket", "INC-000123");',
        'form.append("file", await openAsBlob("screenshot.png"), "screenshot.png");',
        '',
        'const response = await fetch("' + url + '", {',
        '  method: "POST",',
        '  headers: { Authorization: `Bearer ${process.env.HELPDESK_KEY}` },',
        '  body: form,',
        '});',
        'console.log(await response.json());',
      ].join('\n');
    case 'csharp':
      return [
        'using System.Net.Http.Headers;',
        '',
        'using var client = new HttpClient();',
        'client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(',
        '    "Bearer", Environment.GetEnvironmentVariable("HELPDESK_KEY"));',
        '',
        'using var form = new MultipartFormDataContent();',
        'form.Add(new StringContent("INC-000123"), "ticket");',
        'form.Add(new ByteArrayContent(File.ReadAllBytes("screenshot.png")), "file", "screenshot.png");',
        '',
        'var response = await client.PostAsync("' + url + '", form);',
        'Console.WriteLine(await response.Content.ReadAsStringAsync());',
      ].join('\n');
    case 'java':
      return [
        '// The file as base64 in JSON: java.net.http has no multipart helper.',
        'import java.net.URI;',
        'import java.net.http.HttpClient;',
        'import java.net.http.HttpRequest;',
        'import java.net.http.HttpResponse;',
        'import java.nio.file.Files;',
        'import java.nio.file.Path;',
        'import java.util.Base64;',
        '',
        'var content = Base64.getEncoder().encodeToString(Files.readAllBytes(Path.of("screenshot.png")));',
        'var body = """',
        '    { "ticket": "INC-000123",',
        '      "files": [ { "name": "screenshot.png", "content": "%s" } ] }',
        '    """.formatted(content);',
        'var request = HttpRequest.newBuilder(URI.create("' + url + '"))',
        '    .header("Authorization", "Bearer " + System.getenv("HELPDESK_KEY"))',
        '    .header("Content-Type", "application/json")',
        '    .POST(HttpRequest.BodyPublishers.ofString(body))',
        '    .build();',
        'var response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());',
        'System.out.println(response.body());',
      ].join('\n');
    case 'go':
      return [
        'package main',
        '',
        'import (',
        '\t"bytes"',
        '\t"fmt"',
        '\t"io"',
        '\t"mime/multipart"',
        '\t"net/http"',
        '\t"os"',
        ')',
        '',
        'func main() {',
        '\tvar body bytes.Buffer',
        '\tform := multipart.NewWriter(&body)',
        '\tform.WriteField("ticket", "INC-000123")',
        '\tpart, _ := form.CreateFormFile("file", "screenshot.png")',
        '\tfile, _ := os.Open("screenshot.png")',
        '\tio.Copy(part, file)',
        '\tfile.Close()',
        '\tform.Close()',
        '',
        '\treq, _ := http.NewRequest("POST", "' + url + '", &body)',
        '\treq.Header.Set("Authorization", "Bearer "+os.Getenv("HELPDESK_KEY"))',
        '\treq.Header.Set("Content-Type", form.FormDataContentType())',
        '\tresp, err := http.DefaultClient.Do(req)',
        '\tif err != nil {',
        '\t\tpanic(err)',
        '\t}',
        '\tdefer resp.Body.Close()',
        '\tout, _ := io.ReadAll(resp.Body)',
        '\tfmt.Println(string(out))',
        '}',
      ].join('\n');
    case 'php':
      return [
        '<?php',
        "$ch = curl_init('" + url + "');",
        'curl_setopt_array($ch, [',
        '    CURLOPT_POST => true,',
        '    CURLOPT_RETURNTRANSFER => true,',
        "    CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . getenv('HELPDESK_KEY')],",
        '    CURLOPT_POSTFIELDS => [',
        "        'ticket' => 'INC-000123',",
        "        'file' => new CURLFile('screenshot.png'),",
        '    ],',
        ']);',
        'echo curl_exec($ch);',
      ].join('\n');
  }
}

export interface ApiExample {
  title: string;
  /** The automation that answers the request, in words. */
  steps: string;
  body: Body;
  answer: string;
  /** Sends a file: written with apiFileSnippet instead. */
  files?: boolean;
}

export const API_EXAMPLES: ApiExample[] = [
  {
    title: 'Create a ticket',
    steps: 'Create a ticket - raised from your incident template; requester {{request.json.email}}, title {{request.json.title}}, description {{request.json.description}}. No "ticket" in the request: the answer names the one created.',
    body: { email: 'emma@example.com', title: 'Disk full on srv-12', description: 'Free space under 5%' },
    answer: '{ "outcome": "success", "ticket": "INC-000124" }',
  },
  {
    title: 'Set status (one fixed status)',
    steps: 'Set status - Resolved.',
    body: { ticket: 'INC-000123' },
    answer: '{ "outcome": "success", "ticket": "INC-000123" }',
  },
  {
    title: 'Set status (sent in the request)',
    steps: 'Set status - From the request or an earlier step, read from request.json.status. The stored value or the label: resolved, In progress...',
    body: { ticket: 'INC-000123', status: 'in_progress' },
    answer: '{ "outcome": "success", "ticket": "INC-000123" }',
  },
  {
    title: 'Set priority (sent in the request)',
    steps: 'Set priority - From the request, read from request.json.priority: low, normal, high or urgent.',
    body: { ticket: 'INC-000123', priority: 'urgent' },
    answer: '{ "outcome": "success", "ticket": "INC-000123" }',
  },
  {
    title: 'Route to group',
    steps: 'Route to group - Network team. Add an If before it to choose the group by something in the request.',
    body: { ticket: 'INC-000123' },
    answer: '{ "outcome": "success", "ticket": "INC-000123" }',
  },
  {
    title: 'Assign to technician',
    steps: 'Assign to technician - the technician to assign.',
    body: { ticket: 'INC-000123' },
    answer: '{ "outcome": "success", "ticket": "INC-000123" }',
  },
  {
    title: 'Add a comment',
    steps: 'Add a comment - "Monitoring says: {{request.json.message}}", internal note ticked.',
    body: { ticket: 'INC-000123', message: 'CPU back under 80%' },
    answer: '{ "outcome": "success", "ticket": "INC-000123" }',
  },
  {
    title: 'Attach files',
    steps: 'Attach the files from the request (after a Create a ticket step, they go on the new ticket). Upload them as form-data, or put them in the JSON as "files": [{"name": "screenshot.png", "content": "<base64>"}]. Each file is checked like a browser upload; one that is refused is listed in an internal note.',
    body: { ticket: 'INC-000123' },
    answer: '{ "outcome": "success", "ticket": "INC-000123" }',
    files: true,
  },
  {
    title: 'Send notification',
    steps: 'Send notification - a custom notification, to the requester (or an address).',
    body: { ticket: 'INC-000123' },
    answer: '{ "outcome": "success", "ticket": "INC-000123" }',
  },
  {
    title: 'Create a ticket template',
    steps: 'Create a ticket template - named {{request.json.name}}, the kind read from request.json.type (incident, service_request or change_request), based on your default template. Not offered to requesters until somebody ticks it, unless "Offer it to requesters" is ticked on the step. A name already taken is left as it is.',
    body: { name: 'New starter laptop', type: 'service_request', summary: 'Order a laptop for a new colleague' },
    answer: '{ "outcome": "success" }',
  },
  {
    title: 'Create a notification',
    steps: 'Create a notification - named {{request.json.name}}, subject "[{{reference}}] {{title}}", body "<p>{{request.json.message}}</p>". {{reference}}, {{title}} and the other notification placeholders are filled when it is sent; {{request.json.x}} now.',
    body: { name: 'Laptop shipped', message: 'Your laptop is on its way.' },
    answer: '{ "outcome": "success" }',
  },
  {
    title: 'Send HTTP request (pass it on)',
    steps: 'Send HTTP request - POST https://chat.example.com/hook with the body {"text": "{{ticket.reference}}: {{request.json.message}}"}.',
    body: { ticket: 'INC-000123', message: 'Escalated by monitoring' },
    answer: '{ "outcome": "success", "ticket": "INC-000123" }',
  },
  {
    title: 'Several actions, chosen by the request',
    steps: 'If - A value from an earlier step, request.json.action is resolve: Yes leads to Set status - Resolved; No leads to Add a comment - {{request.json.message}}.',
    body: { ticket: 'INC-000123', action: 'resolve', message: 'Fixed by the night job' },
    answer: '{ "outcome": "success", "ticket": "INC-000123" }',
  },
];

/** Every example with its request written in every language. */
export function apiGuide(url: string): (ApiExample & { snippets: { language: ApiLanguage; code: string }[] })[] {
  return API_EXAMPLES.map((example) => ({
    ...example,
    snippets: API_LANGUAGES.map((l) => ({
      language: l.key,
      code: example.files ? apiFileSnippet(l.key, url) : apiSnippet(l.key, url, example.body),
    })),
  }));
}

// ---------------------------------------------------------------------------
// Reading: GET /api/v1
// ---------------------------------------------------------------------------

/** A GET in each language; the key from HELPDESK_KEY, as everywhere. */
export function apiGetSnippet(language: ApiLanguage, url: string): string {
  switch (language) {
    case 'curl':
      return 'curl "' + url + '" \\\n  -H "Authorization: Bearer $HELPDESK_KEY"';
    case 'postman':
      return [
        'In Postman: New > HTTP request, then fill in:',
        '',
        '  Method          GET',
        '  URL             ' + url,
        '',
        '  Authorization tab',
        '    Auth Type     Bearer Token',
        '    Token         {{helpdeskKey}}',
        '',
        'No body. Press Send; the ticket comes back as JSON underneath.',
        'The part after ? can also be filled in on the Params tab, one row each.',
      ].join('\n');
    case 'powershell':
      return [
        '$headers = @{ Authorization = "Bearer $env:HELPDESK_KEY" }',
        'Invoke-RestMethod -Uri "' + url + '" -Headers $headers',
      ].join('\n');
    case 'python':
      return [
        'import os',
        'import requests',
        '',
        'response = requests.get(',
        '    "' + url + '",',
        '    headers={"Authorization": "Bearer " + os.environ["HELPDESK_KEY"]},',
        '    timeout=30,',
        ')',
        'response.raise_for_status()',
        'print(response.json())',
      ].join('\n');
    case 'javascript':
      return [
        '// Node.js 18 or later',
        'const response = await fetch("' + url + '", {',
        '  headers: { Authorization: `Bearer ${process.env.HELPDESK_KEY}` },',
        '});',
        'console.log(await response.json());',
      ].join('\n');
    case 'csharp':
      return [
        'using System.Net.Http.Headers;',
        '',
        'using var client = new HttpClient();',
        'client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(',
        '    "Bearer", Environment.GetEnvironmentVariable("HELPDESK_KEY"));',
        '',
        'Console.WriteLine(await client.GetStringAsync("' + url + '"));',
      ].join('\n');
    case 'java':
      return [
        'import java.net.URI;',
        'import java.net.http.HttpClient;',
        'import java.net.http.HttpRequest;',
        'import java.net.http.HttpResponse;',
        '',
        'var request = HttpRequest.newBuilder(URI.create("' + url + '"))',
        '    .header("Authorization", "Bearer " + System.getenv("HELPDESK_KEY"))',
        '    .GET()',
        '    .build();',
        'var response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());',
        'System.out.println(response.body());',
      ].join('\n');
    case 'go':
      return [
        'package main',
        '',
        'import (',
        '\t"fmt"',
        '\t"io"',
        '\t"net/http"',
        '\t"os"',
        ')',
        '',
        'func main() {',
        '\treq, _ := http.NewRequest("GET", "' + url + '", nil)',
        '\treq.Header.Set("Authorization", "Bearer "+os.Getenv("HELPDESK_KEY"))',
        '\tresp, err := http.DefaultClient.Do(req)',
        '\tif err != nil {',
        '\t\tpanic(err)',
        '\t}',
        '\tdefer resp.Body.Close()',
        '\tout, _ := io.ReadAll(resp.Body)',
        '\tfmt.Println(string(out))',
        '}',
      ].join('\n');
    case 'php':
      return [
        '<?php',
        "$ch = curl_init('" + url + "');",
        'curl_setopt_array($ch, [',
        '    CURLOPT_RETURNTRANSFER => true,',
        "    CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . getenv('HELPDESK_KEY')],",
        ']);',
        'echo curl_exec($ch);',
      ].join('\n');
  }
}

export interface ReadExample {
  title: string;
  explain: string;
  path: string;
  answer: string;
}

export const READ_EXAMPLES: ReadExample[] = [
  {
    title: 'One ticket: status and everything else',
    explain: 'By reference (or id). Status, priority, type, requester, assignee, group, category, template, dates, the SLA clocks, its tasks and its files (names and sizes, not the files themselves).',
    path: '/tickets/INC-000123',
    answer: [
      '{',
      '  "reference": "INC-000123",',
      '  "title": "Disk full on srv-12",',
      '  "status": "in_progress", "statusLabel": "In progress",',
      '  "priority": "urgent", "priorityLabel": "Urgent",',
      '  "type": "incident", "typeLabel": "Incident",',
      '  "requester": { "name": "Emma Wilson", "email": "emma@example.com" },',
      '  "assignee": { "name": "Peter Fisher", "email": "peter@example.com" },',
      '  "group": "Infrastructure",',
      '  "category": "Hardware › Servers",',
      '  "createdAt": "2026-10-12T08:14:03.120Z",',
      '  "updatedAt": "2026-10-12T09:40:51.002Z",',
      '  "resolvedAt": null, "closedAt": null,',
      '  "sla": { "response": { "state": "met", ... }, "resolution": { "state": "due", ... } },',
      '  "tasks": [], "files": [ { "name": "screenshot.png", "size": 48213, ... } ],',
      '  "url": "https://servicedesk.example.com/tickets/..."',
      '}',
    ].join('\n'),
  },
  {
    title: 'Only its status',
    explain: 'There is no separate address for the status: read "status" (stored value) or "statusLabel" (as people read it) from the ticket. In PowerShell: (Invoke-RestMethod ...).status',
    path: '/tickets/INC-000123',
    answer: '"status": "pending", "statusLabel": "On hold"',
  },
  {
    title: 'All tickets',
    explain: 'No filters: every ticket the key may read, newest change first, 50 at a time (add &limit=100 for up to 100). "total" says how many there are; ask again with offset set to "next" until it is null. Tasks are left out unless you add &tasks=include.',
    path: '/tickets',
    answer: '{ "total": 312, "limit": 50, "offset": 0, "next": 50, "items": [ { "reference": "INC-000312", "title": "...", "status": "open", ... }, ... ] }',
  },
  {
    title: 'The next page of all tickets',
    explain: 'The same address with offset - here the second page of 100. Keep going while "next" is not null.',
    path: '/tickets?limit=100&offset=100',
    answer: '{ "total": 312, "limit": 100, "offset": 100, "next": 200, "items": [ ... ] }',
  },
  {
    title: 'A list: open tickets of one requester',
    explain: 'Filters, all optional and combinable: status and priority (comma-separated), requester (email), group (name), updatedSince (date and time), tasks=include. Newest change first, 50 at a time (limit up to 100); "next" is the offset of the next page, or null.',
    path: '/tickets?status=open,in_progress&requester=emma@example.com',
    answer: '{ "total": 2, "limit": 50, "offset": 0, "next": null, "items": [ { "reference": "INC-000123", ... } ] }',
  },
  {
    title: 'Filters together: urgent unassigned incidents',
    explain: 'Filters combine - every one must match. Here: incidents, high or urgent, nobody assigned yet, raised this month.',
    path: '/tickets?type=incident&priority=high,urgent&assignee=none&createdSince=2026-10-01T00:00:00Z',
    answer: '{ "total": 3, "limit": 50, "offset": 0, "next": null, "items": [ ... ] }',
  },
  {
    title: 'Search the titles',
    explain: 'Every ticket with these words in its title, any case - here "printer", still open.',
    path: '/tickets?search=printer&status=open,in_progress,pending',
    answer: '{ "total": 4, "limit": 50, "offset": 0, "next": null, "items": [ ... ] }',
  },
  {
    title: 'What changed since a time',
    explain: 'For a system that asks every few minutes: remember when you last asked, and send it as updatedSince.',
    path: '/tickets?updatedSince=2026-10-12T08:00:00Z&limit=100',
    answer: '{ "total": 7, "limit": 100, "offset": 0, "next": null, "items": [ ... ] }',
  },
  {
    title: 'Its comments',
    explain: 'The conversation, oldest first. Internal notes only with "Read internal notes too" ticked on the key; "includesInternal" says which you got.',
    path: '/tickets/INC-000123/comments',
    answer: '{ "reference": "INC-000123", "includesInternal": false, "items": [ { "author": "Peter Fisher", "body": "Cleaning up /var/log now.", "internal": false, "createdAt": "..." } ] }',
  },
];

/** Every read example in every language, against this service desk. */
export function apiReadGuide(origin: string): (ReadExample & { snippets: { language: ApiLanguage; code: string }[] })[] {
  return READ_EXAMPLES.map((e) => ({
    ...e,
    snippets: API_LANGUAGES.map((l) => ({ language: l.key, code: apiGetSnippet(l.key, origin + '/api/v1' + e.path) })),
  }));
}

// ---------------------------------------------------------------------------
// Changing: POST and PATCH /api/v1, no automation needed
// ---------------------------------------------------------------------------

export interface WriteExample {
  title: string;
  explain: string;
  method: 'POST' | 'PATCH';
  path: string;
  /** The tick the key needs, as the key's page words it. */
  needs: string;
  body: Body;
  answer: string;
}

export const WRITE_EXAMPLES: WriteExample[] = [
  {
    title: 'Create a ticket',
    explain: 'Raised from a template, by its name - with its fields, routing and tasks. "requester" is an email address: an account here, or anybody (they get the ticket, never an account). priority, group and assignee are optional, and each needs its own tick.',
    method: 'POST',
    path: '/tickets',
    needs: 'Create a ticket',
    body: { template: 'Default Incident request', title: 'VPN drops every hour', description: 'Since the update on Monday.', requester: 'emma@example.com', priority: 'high' },
    answer: '201 { "reference": "INC-000124", "id": "...", "url": "https://.../tickets/..." }',
  },
  {
    title: 'Assign to a technician',
    explain: 'By the technician\'s email address - an active technician or administrator. "none" unassigns.',
    method: 'PATCH',
    path: '/tickets/INC-000123',
    needs: 'Assign to technician',
    body: { assignee: 'peter@example.com' },
    answer: '200 { "reference": "INC-000123", "changed": ["assignee"] }',
  },
  {
    title: 'Route to a group',
    explain: 'By the technician group\'s name. "none" takes it out of every group.',
    method: 'PATCH',
    path: '/tickets/INC-000123',
    needs: 'Route to group',
    body: { group: 'Network' },
    answer: '200 { "reference": "INC-000123", "changed": ["group"] }',
  },
  {
    title: 'Set the status',
    explain: 'The stored word or the label: open, in_progress, "In progress", pending or "On hold", resolved, closed, cancelled. On hold needs a "note" (posted as a comment), as on the page; so do cancelling and resolving where Settings asks for a note. An approval awaited or a task still open is refused with 409.',
    method: 'PATCH',
    path: '/tickets/INC-000123',
    needs: 'Set status',
    body: { status: 'resolved', note: 'Replaced the switch in rack 4.' },
    answer: '200 { "reference": "INC-000123", "changed": ["status"] }',
  },
  {
    title: 'Several changes at once',
    explain: 'Any of status, priority, group and assignee together - the key needs a tick for each one sent.',
    method: 'PATCH',
    path: '/tickets/INC-000123',
    needs: 'Set status, Set priority, Route to group, Assign to technician',
    body: { status: 'in_progress', priority: 'urgent', group: 'Network', assignee: 'peter@example.com' },
    answer: '200 { "reference": "INC-000123", "changed": ["status", "priority", "group", "assignee"] }',
  },
  {
    title: 'Add a comment',
    explain: 'Public unless "internal" is true. Written as the person who made the key.',
    method: 'POST',
    path: '/tickets/INC-000123/comments',
    needs: 'Add a comment',
    body: { body: 'Monitoring: CPU back under 80%.', internal: 'true' },
    answer: '201 { "reference": "INC-000123", "internal": true }',
  },
  {
    title: 'Send a notification',
    explain: 'Any notification, built-in or custom, by its name. "to" is requester (the default), assignee, group, manager, approver or an email address.',
    method: 'POST',
    path: '/tickets/INC-000123/notifications',
    needs: 'Send notification',
    body: { notification: 'Laptop shipped', to: 'requester' },
    answer: '200 { "reference": "INC-000123", "queued": 1 }',
  },
  {
    title: 'Create a ticket template',
    explain: 'The kind is service_request (the default), incident or change_request; "basedOn" copies another template\'s form. Not offered to requesters unless "offer" is true - something another system made is checked by a person first. A name already taken is refused with 409.',
    method: 'POST',
    path: '/templates',
    needs: 'Create a ticket template',
    body: { name: 'New starter laptop', type: 'service_request', summary: 'Order a laptop for a new colleague', basedOn: 'Default Incident request' },
    answer: '201 { "id": "...", "name": "New starter laptop", "type": "service_request", "offered": false }',
  },
  {
    title: 'Create a notification',
    explain: 'A custom notification, to send later. Its own placeholders - {{reference}}, {{title}}, {{requesterName}}... - are filled each time it is sent.',
    method: 'POST',
    path: '/notifications',
    needs: 'Create a notification',
    body: { name: 'Laptop shipped', subject: '[{{reference}}] Your laptop is on its way', body: '<p>Hello {{requesterName}}, your laptop has shipped.</p>' },
    answer: '201 { "id": "...", "name": "Laptop shipped" }',
  },
];

/** Every write example in every language, against this service desk. */
export function apiWriteGuide(origin: string): (WriteExample & { snippets: { language: ApiLanguage; code: string }[] })[] {
  return WRITE_EXAMPLES.map((e) => ({
    ...e,
    snippets: API_LANGUAGES.map((l) => ({ language: l.key, code: apiSnippet(l.key, origin + '/api/v1' + e.path, e.body, e.method) })),
  }));
}
