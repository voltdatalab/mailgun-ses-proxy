-- Clean installs receive the Prisma-mapped names below. Existing installations may
-- have an equivalent index under a legacy name; that non-destructive drift is
-- intentionally reused rather than renamed, dropped, or duplicated.
--
-- Expected names with different definitions are unsafe drift. All index metadata
-- is preflighted before any DDL is prepared, then one deterministic prepared
-- sentinel aborts the migration if either expected name is incompatible. The
-- sentinel is in the system metadata schema and cannot be supplied by an
-- application schema; its fixed name makes the failure clear without exposing
-- observed metadata.
-- Runtime compatibility and lock behavior must still be exercised in Task 12/14.

-- NewsletterNotifications(type, created, id), non-unique preflight
SET @analytics_notifications_expected_name_exists := (
    SELECT EXISTS(
        SELECT 1
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'NewsletterNotifications'
          AND INDEX_NAME = 'idx_notifications_type_created_id'
    )
);
SET @analytics_notifications_expected_name_matches := (
    SELECT COALESCE(
        (
            SELECT COUNT(*) = 3
               AND MIN(NON_UNIQUE) = 1
               AND MAX(NON_UNIQUE) = 1
               AND MIN(SUB_PART IS NULL) = 1
               AND MIN(COLLATION) = 'A'
               AND MAX(COLLATION) = 'A'
               AND MIN(INDEX_TYPE) = 'BTREE'
               AND MAX(INDEX_TYPE) = 'BTREE'
               AND GROUP_CONCAT(
                    CONCAT(SEQ_IN_INDEX, ':', COLUMN_NAME)
                    ORDER BY SEQ_IN_INDEX SEPARATOR ','
               ) = '1:type,2:created,3:id'
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'NewsletterNotifications'
              AND INDEX_NAME = 'idx_notifications_type_created_id'
        ),
        0
    )
);
SET @analytics_notifications_equivalent_definition_exists := EXISTS(
    SELECT 1
    FROM (
        SELECT INDEX_NAME
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'NewsletterNotifications'
          AND INDEX_NAME <> 'idx_notifications_type_created_id'
        GROUP BY INDEX_NAME
        HAVING COUNT(*) = 3
           AND MIN(NON_UNIQUE) = 1
           AND MAX(NON_UNIQUE) = 1
           AND MIN(SUB_PART IS NULL) = 1
           AND MIN(COLLATION) = 'A'
           AND MAX(COLLATION) = 'A'
           AND MIN(INDEX_TYPE) = 'BTREE'
           AND MAX(INDEX_TYPE) = 'BTREE'
           AND GROUP_CONCAT(
                CONCAT(SEQ_IN_INDEX, ':', COLUMN_NAME)
                ORDER BY SEQ_IN_INDEX SEPARATOR ','
           ) = '1:type,2:created,3:id'
    ) AS analytics_equivalent_indexes
);

-- NewsletterBatch(siteId), non-unique preflight
SET @analytics_batch_expected_name_exists := (
    SELECT EXISTS(
        SELECT 1
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'NewsletterBatch'
          AND INDEX_NAME = 'NewsletterBatch_siteId_idx'
    )
);
SET @analytics_batch_expected_name_matches := (
    SELECT COALESCE(
        (
            SELECT COUNT(*) = 1
               AND MIN(NON_UNIQUE) = 1
               AND MAX(NON_UNIQUE) = 1
               AND MIN(SUB_PART IS NULL) = 1
               AND MIN(COLLATION) = 'A'
               AND MAX(COLLATION) = 'A'
               AND MIN(INDEX_TYPE) = 'BTREE'
               AND MAX(INDEX_TYPE) = 'BTREE'
               AND GROUP_CONCAT(
                    CONCAT(SEQ_IN_INDEX, ':', COLUMN_NAME)
                    ORDER BY SEQ_IN_INDEX SEPARATOR ','
               ) = '1:siteId'
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'NewsletterBatch'
              AND INDEX_NAME = 'NewsletterBatch_siteId_idx'
        ),
        0
    )
);
SET @analytics_batch_equivalent_definition_exists := EXISTS(
    SELECT 1
    FROM (
        SELECT INDEX_NAME
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'NewsletterBatch'
          AND INDEX_NAME <> 'NewsletterBatch_siteId_idx'
        GROUP BY INDEX_NAME
        HAVING COUNT(*) = 1
           AND MIN(NON_UNIQUE) = 1
           AND MAX(NON_UNIQUE) = 1
           AND MIN(SUB_PART IS NULL) = 1
           AND MIN(COLLATION) = 'A'
           AND MAX(COLLATION) = 'A'
           AND MIN(INDEX_TYPE) = 'BTREE'
           AND MAX(INDEX_TYPE) = 'BTREE'
           AND GROUP_CONCAT(
                CONCAT(SEQ_IN_INDEX, ':', COLUMN_NAME)
                ORDER BY SEQ_IN_INDEX SEPARATOR ','
           ) = '1:siteId'
    ) AS analytics_equivalent_indexes
);

-- No DDL may be prepared before both expected-name definitions pass preflight.
SET @analytics_preflight_sql := IF(
    (@analytics_notifications_expected_name_exists = 1
        AND @analytics_notifications_expected_name_matches = 0)
    OR (@analytics_batch_expected_name_exists = 1
        AND @analytics_batch_expected_name_matches = 0),
    'SELECT * FROM information_schema.__analytics_index_definition_mismatch__',
    'SELECT 1'
);
PREPARE analytics_preflight_statement FROM @analytics_preflight_sql;
EXECUTE analytics_preflight_statement;
DEALLOCATE PREPARE analytics_preflight_statement;

-- Reuse a matching expected or legacy-named notifications index; otherwise create it.
SET @analytics_notifications_index_sql := IF(
    @analytics_notifications_expected_name_matches = 1
        OR @analytics_notifications_equivalent_definition_exists = 1,
    'SELECT 1',
    'CREATE INDEX `idx_notifications_type_created_id` ON `NewsletterNotifications` (`type`, `created`, `id`)'
);
PREPARE analytics_notifications_index_statement FROM @analytics_notifications_index_sql;
EXECUTE analytics_notifications_index_statement;
DEALLOCATE PREPARE analytics_notifications_index_statement;

-- Reuse a matching expected or legacy-named batch index; otherwise create it.
SET @analytics_batch_index_sql := IF(
    @analytics_batch_expected_name_matches = 1
        OR @analytics_batch_equivalent_definition_exists = 1,
    'SELECT 1',
    'CREATE INDEX `NewsletterBatch_siteId_idx` ON `NewsletterBatch` (`siteId`)'
);
PREPARE analytics_batch_index_statement FROM @analytics_batch_index_sql;
EXECUTE analytics_batch_index_statement;
DEALLOCATE PREPARE analytics_batch_index_statement;
