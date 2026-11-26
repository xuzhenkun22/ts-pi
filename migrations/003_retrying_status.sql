ALTER TABLE tasks MODIFY status ENUM('queued','running','succeeded','failed','retrying') NOT NULL DEFAULT 'queued';
