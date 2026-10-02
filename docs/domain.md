# Dispatch Domain Rules

## Users
A user represents an email identity known to Dispatch.

A user may exist before their email address has been verified.

User-specific concerns such as subscriptions and verification 
requests should not be stored directly on the user record unless
they describe the user's identity.

## Email Verification
Verification proves control of a user's email address.

Verification tokens are cryptographically random. Only the token
hash may be persisted. Raw verification tokens must never be 
persisted or logged.

Verification tokens expire.

Only newest verification request may remain valid.
Creating new verification requests invalidates previous oustanding
requests.

Once a user has been verified, they should not enter the 
new-subscriber verification process while they remain an active subsriber.

## Subscription Management
Verification credentials and subscription management credentials are
separate concepts with separate lifecycles.

The recovery process for a lost management link has not yet been defined.