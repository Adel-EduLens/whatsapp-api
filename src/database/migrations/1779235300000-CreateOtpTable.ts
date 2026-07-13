import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOtpTable1779235300000 implements MigrationInterface {
  name = 'CreateOtpTable1779235300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      await this.upPostgres(queryRunner);
    } else {
      await this.upSqlite(queryRunner);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      await this.downPostgres(queryRunner);
    } else {
      await this.downSqlite(queryRunner);
    }
  }

  // ──────────────────────────────────────────────
  //  SQLite
  // ──────────────────────────────────────────────

  private async upSqlite(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "otps" (
        "id" varchar PRIMARY KEY NOT NULL, 
        "phone" varchar(30) NOT NULL, 
        "code" varchar(10) NOT NULL, 
        "sessionId" varchar NOT NULL, 
        "callbackUrl" varchar(2048), 
        "callbackSecret" varchar(255), 
        "status" varchar(20) NOT NULL DEFAULT 'pending', 
        "expiresAt" datetime NOT NULL, 
        "verifiedAt" datetime, 
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_otp_phone_status" ON "otps" ("phone", "status")`);
    await queryRunner.query(`CREATE INDEX "IDX_otp_session_status" ON "otps" ("sessionId", "status")`);
  }

  private async downSqlite(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_otp_session_status"`);
    await queryRunner.query(`DROP INDEX "IDX_otp_phone_status"`);
    await queryRunner.query(`DROP TABLE "otps"`);
  }

  // ──────────────────────────────────────────────
  //  PostgreSQL
  // ──────────────────────────────────────────────

  private async upPostgres(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "otps" (
        "id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, 
        "phone" varchar(30) NOT NULL, 
        "code" varchar(10) NOT NULL, 
        "sessionId" varchar NOT NULL, 
        "callbackUrl" varchar(2048), 
        "callbackSecret" varchar(255), 
        "status" varchar(20) NOT NULL DEFAULT 'pending', 
        "expiresAt" timestamp NOT NULL, 
        "verifiedAt" timestamp, 
        "createdAt" timestamp NOT NULL DEFAULT NOW()
      )`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_otp_phone_status" ON "otps" ("phone", "status")`);
    await queryRunner.query(`CREATE INDEX "IDX_otp_session_status" ON "otps" ("sessionId", "status")`);
  }

  private async downPostgres(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_otp_session_status"`);
    await queryRunner.query(`DROP INDEX "IDX_otp_phone_status"`);
    await queryRunner.query(`DROP TABLE "otps"`);
  }
}
