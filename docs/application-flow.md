# Application flow

The application layer is the operational coordinator between Signal adapters, the pure Case Core, and persistence.

```
AttentionSignal
     |
     v
CaseService.openFromSignal()
     |
     v
case_created
     |
     v
CaseRepository
     |
     +--> current snapshot
     +--> append-only events
```

Every responder action goes through the same path:

```
load tenantId + caseId
  -> execute pure Core command
  -> compare expectedVersion
  -> append event atomically
  -> return new aggregate
```

The application layer does not decide medical or welfare outcomes. It coordinates accountable human operations.

Signal adapters may differ by domain, but once a Signal becomes a Case, the lifecycle is identical.
