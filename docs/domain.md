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

The public onboarding response must not reveal whether an email address already
belongs to a Dispatch user. 

"An email has been sent, please check your inbox to continue."

## Subscription Management
Verification credentials and subscription management credentials are
separate concepts with separate lifecycles.

The recovery process for a lost management link has not yet been defined.

One management email authorizes one successful management change: update
preference(s) or unsubscribe.

Management token:
    Lifetime: 30m
    Clicking/viewing: does NOT consume
    Successful update/unsub: consume and invalidate other outstanding management tokens
    Failed update/unsub: does NOT consume
    Multiple requested tokens: may coexist until expiration