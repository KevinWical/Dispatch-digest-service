# Dispatch Architecture

## Web Client
  React front end
  New subscriber:
  Signup -> Verification request -> Verification Confirmation -> Preferences -> subscribe
  Existing subscriber:
  Management link -> Preferences -> Update/Unsubscribe

## Express API
  Endpoints for email verification, create subscription, edit subscription/unsubscribe (via management link)

## Sports Data Ingest
  Retrieves and normalizes data from ESPN endpoints
  Raw data needs to be formatted to fit into standings, team scores, etc.
  Normalized data is persisted in MySQL

## Digest Worker
  Determines which subscribers are due for a digest, retrieves the appropriate normalized data, and constructs the structured content of each subscriber's digest.
  Sends digest content and destination to Email Delivery.

## Email Delivery
  Selects appropriate email template, renders structured content into that template, and sends verification or digest email.
  Does not retrieve data from providers or choose when to send emails.

## MySQL
  Persistent storage
  Replacing an outstanding verification request must be atomic. A failure while creating the replacement
  must not invalidate the existing request.

## Data Flow
### Ingestion
ESPN -> normalize raw provider data -> persist in SQL

### Digest Delivery
The schedule/trigger mechanism for the digest worker has not been selected yet.
Digest worker requests data from SQL -> sends data + subscriber to Email Delivery

## Open Questions
-How can we prevent duplicate delivery if an email sends successfully but the runner crashes before recording successful delivery?
-Sportsball used CBS Sports as a backup if the ESPN endpoint failed; would like to expand on this.
-Do preseason games need to be filtered out of season standings?
-What is the intended behavior for the offseason(s)?
-Is daily too frequent?
-Would separate emails make sense for separate topics? Could be easier to read and orchestrate.
-How should digest emails provide direct unsubscribe and management entry while creds are short-lived.

## Closed Questions
-What is the intended behavior when an active subscriber attempts to subscribe?
  -Send them a manage preferences link
-What happens if the digest worker has a failure mid subscriber list?
  -We use a SQL transaction to preserve atomicity.
-If a user unsubscribes, and chooses to later resubscribe, they will need to re-enter their preferences.
  -Delete user on unsubscribe.