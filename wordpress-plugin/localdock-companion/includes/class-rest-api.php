<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Read-only REST endpoint for LocalDock to poll for changes since its last sync.
 * No write-back capability is ever exposed here, even with a valid key.
 */
class LocalDock_REST_API {

	const REST_NAMESPACE = 'localdock/v1';

	public static function register_routes() {
		register_rest_route(
			self::REST_NAMESPACE,
			'/changes',
			array(
				'methods'             => 'GET',
				'callback'            => array( __CLASS__, 'get_changes' ),
				'permission_callback' => array( __CLASS__, 'check_api_key' ),
				'args'                => array(
					'since' => array(
						'required'          => false,
						'validate_callback' => function ( $value ) {
							return is_numeric( $value );
						},
					),
				),
			)
		);
	}

	public static function check_api_key( \WP_REST_Request $request ) {
		$provided = $request->get_header( 'X-LocalDock-Key' );
		$expected = get_option( 'localdock_api_key' );

		if ( empty( $expected ) || empty( $provided ) ) {
			return false;
		}

		return hash_equals( $expected, $provided );
	}

	public static function get_changes( \WP_REST_Request $request ) {
		global $wpdb;

		$since      = $request->get_param( 'since' );
		$table_name = $wpdb->prefix . LocalDock_Changelog::TABLE;

		if ( $since ) {
			$since_gmt = gmdate( 'Y-m-d H:i:s', (int) $since );
			$rows      = $wpdb->get_results(
				$wpdb->prepare(
					"SELECT id, object_type, object_id, action, created_at FROM {$table_name} WHERE created_at > %s ORDER BY id ASC",
					$since_gmt
				)
			);
		} else {
			$rows = $wpdb->get_results(
				"SELECT id, object_type, object_id, action, created_at FROM {$table_name} ORDER BY id DESC LIMIT 50"
			);
		}

		return rest_ensure_response(
			array(
				'server_time' => time(),
				'changes'     => $rows,
			)
		);
	}
}
