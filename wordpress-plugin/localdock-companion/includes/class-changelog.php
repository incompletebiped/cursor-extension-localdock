<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Hooks into native WP change events and logs them to wp_localdock_changelog.
 */
class LocalDock_Changelog {

	const TABLE = 'localdock_changelog';
	const CRON_HOOK = 'localdock_prune_changelog_event';
	const DEFAULT_RETENTION_DAYS = 30;

	public static function init() {
		add_action( 'save_post', array( __CLASS__, 'log_save_post' ), 10, 2 );
		add_action( 'deleted_post', array( __CLASS__, 'log_deleted_post' ) );
		add_action( 'updated_option', array( __CLASS__, 'log_updated_option' ) );
		add_action( 'activated_plugin', array( __CLASS__, 'log_activated_plugin' ) );
		add_action( 'deactivated_plugin', array( __CLASS__, 'log_deactivated_plugin' ) );
		add_action( 'switch_theme', array( __CLASS__, 'log_switch_theme' ) );
		add_action( 'add_attachment', array( __CLASS__, 'log_add_attachment' ) );
		add_action( 'wp_update_user', array( __CLASS__, 'log_wp_update_user' ) );
		add_action( self::CRON_HOOK, array( __CLASS__, 'prune' ) );
	}

	public static function on_activate() {
		self::create_table();

		if ( false === get_option( 'localdock_api_key' ) ) {
			update_option( 'localdock_api_key', wp_generate_password( 40, false, false ) );
		}

		if ( ! wp_next_scheduled( self::CRON_HOOK ) ) {
			wp_schedule_event( time(), 'daily', self::CRON_HOOK );
		}
	}

	public static function on_deactivate() {
		wp_clear_scheduled_hook( self::CRON_HOOK );
	}

	/**
	 * Deletes changelog rows older than the retention window.
	 * Runs daily via WP-Cron. Filterable so a site owner can tighten/loosen
	 * retention without editing plugin code; a filtered value of 0 disables pruning.
	 */
	public static function prune() {
		global $wpdb;

		$retention_days = (int) apply_filters( 'localdock_companion_retention_days', self::DEFAULT_RETENTION_DAYS );

		if ( $retention_days <= 0 ) {
			return;
		}

		$table_name = $wpdb->prefix . self::TABLE;
		$cutoff     = gmdate( 'Y-m-d H:i:s', time() - ( $retention_days * DAY_IN_SECONDS ) );

		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$table_name} WHERE created_at < %s",
				$cutoff
			)
		);
	}

	private static function create_table() {
		global $wpdb;

		$table_name      = $wpdb->prefix . self::TABLE;
		$charset_collate = $wpdb->get_charset_collate();

		$sql = "CREATE TABLE {$table_name} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			object_type VARCHAR(32) NOT NULL,
			object_id BIGINT UNSIGNED NULL,
			action VARCHAR(32) NOT NULL,
			created_at DATETIME NOT NULL,
			PRIMARY KEY  (id),
			KEY created_at (created_at)
		) {$charset_collate};";

		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		dbDelta( $sql );
	}

	private static function record( $object_type, $object_id, $action ) {
		global $wpdb;

		$wpdb->insert(
			$wpdb->prefix . self::TABLE,
			array(
				'object_type' => $object_type,
				'object_id'   => $object_id,
				'action'      => $action,
				'created_at'  => current_time( 'mysql', true ),
			),
			array( '%s', '%d', '%s', '%s' )
		);
	}

	public static function log_save_post( $post_id, $post ) {
		if ( wp_is_post_revision( $post_id ) || wp_is_post_autosave( $post_id ) ) {
			return;
		}

		$action = ( 'auto-draft' === $post->post_status ) ? 'created' : 'updated';
		self::record( 'post', $post_id, $action );
	}

	public static function log_deleted_post( $post_id ) {
		self::record( 'post', $post_id, 'deleted' );
	}

	public static function log_updated_option( $option ) {
		self::record( 'option', null, 'updated:' . $option );
	}

	public static function log_activated_plugin( $plugin ) {
		self::record( 'plugin', null, 'activated:' . $plugin );
	}

	public static function log_deactivated_plugin( $plugin ) {
		self::record( 'plugin', null, 'deactivated:' . $plugin );
	}

	public static function log_switch_theme( $new_name ) {
		self::record( 'theme', null, 'switched:' . $new_name );
	}

	public static function log_add_attachment( $attachment_id ) {
		self::record( 'attachment', $attachment_id, 'created' );
	}

	public static function log_wp_update_user( $user_id ) {
		self::record( 'user', $user_id, 'updated' );
	}
}
