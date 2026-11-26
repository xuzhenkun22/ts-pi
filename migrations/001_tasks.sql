CREATE TABLE IF NOT EXISTS tasks (
  id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
  cwd VARCHAR(1024) NOT NULL,
  directory_key CHAR(64) CHARACTER SET ascii NOT NULL UNIQUE,
  prompt TEXT NOT NULL,
  model VARCHAR(255) NOT NULL,
  status ENUM('queued','running','succeeded','failed') NOT NULL DEFAULT 'queued',
  reply MEDIUMTEXT NULL,
  error VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at DATETIME(3) NULL,
  deadline_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  next_dispatch_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_dispatch (status, next_dispatch_at),
  INDEX idx_deadline (status, deadline_at),
  INDEX idx_created (created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS task_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id CHAR(36) CHARACTER SET ascii NOT NULL,
  message VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_task_logs (task_id, id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
